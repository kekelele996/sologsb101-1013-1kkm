/**
 * 同步对账 store：外业账 → 分级账的发件箱与对账规则。
 *
 * 现场断网照旧记账：外业的每条增删改先落 IndexedDB，再按实体合并进 outbox；
 * 网络恢复（或手动「立即对账」）后按样带编号（稳定样带 id）与分级组对账：
 * - 已定级样带的覆盖依据哈希对不上 → 自动转「待复核」并挂 syncIssues，等人工裁定，等级保留旧的
 * - 外业已删除 / 礁区已删除 / 同站位编号重复 → 挂分歧，等人定
 * - 同步中断（演示开关模拟）→ 发件箱原样留外业、记录失败次数与原因、分级组那份一个字节不动，稍后重试
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, LS_KEYS, watchTable } from '@/utils/db'
import type {
  BeltGrade,
  IssueKind,
  OutboxEntity,
  OutboxItem,
  SyncIssue
} from '@/types/grading'
import { beltBasisHash } from '@/utils/basis'
import type { Belt } from '@/types/belt'

export interface FlushResult {
  ran: boolean
  reason?: 'offline' | 'empty' | 'interrupted'
  synced: number
  pendingReview: number
  conflicts: number
  cleared: number
}

/** 失败时的统一提示（同步中断演示开关触发） */
const INTERRUPTED_MESSAGE = '同步中断：与分级组的连接被重置，发件箱保留待重试，分级账未改动'

function readOnlineInitial(): boolean {
  try {
    return localStorage.getItem(LS_KEYS.online) !== '0'
  } catch {
    return true
  }
}

function outboxId(entity: OutboxEntity, entityId: string): string {
  return `${entity}:${entityId}`
}

export const useSyncStore = defineStore('sync', () => {
  const outbox = ref<OutboxItem[]>([])
  const issues = ref<SyncIssue[]>([])
  const online = ref<boolean>(readOnlineInitial())
  /** 同步中断模拟开关：为 true 时下一次对账必失败（分级账不动，外业留重试） */
  const failNextFlush = ref(false)
  const syncing = ref(false)
  const lastSyncAt = ref<number | null>(null)
  const lastSyncError = ref<string | null>(null)

  let started = false
  let autoTimer: ReturnType<typeof setTimeout> | null = null

  const openIssues = computed(() =>
    issues.value
      .filter((issue) => issue.resolvedAt === null)
      .sort((a, b) => b.createdAt - a.createdAt)
  )

  const pendingCount = computed(() => outbox.value.length)
  const failedItems = computed(() => outbox.value.filter((item) => item.lastError !== null))
  const hasFailure = computed(() => failedItems.value.length > 0 || lastSyncError.value !== null)
  const lastAttemptAt = computed<number | null>(() =>
    outbox.value.reduce<number | null>((max, item) => {
      const t = item.updatedAt
      return max === null || t > max ? t : max
    }, null)
  )

  function start(): void {
    if (started) return
    started = true
    watchTable<OutboxItem>(() => db.outbox).subscribe((rows) => {
      outbox.value = rows
    })
    watchTable<SyncIssue>(() => db.syncIssues).subscribe((rows) => {
      issues.value = rows
    })
    // 浏览器自身在线状态只作默认参考；现场断网演示以工作台手动开关为准
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (online.value) void flush()
      })
      // 启动时若在线且发件箱有积压（上次中断 / 关页面前没发完），自动补一次对账
      if (online.value) {
        setTimeout(() => {
          if (outbox.value.length > 0) void flush()
        }, 600)
      }
    }
  }

  function setOnline(value: boolean): void {
    online.value = value
    try {
      localStorage.setItem(LS_KEYS.online, value ? '1' : '0')
    } catch {
      // 忽略
    }
    if (value) void flush()
  }

  function setFailNextFlush(value: boolean): void {
    failNextFlush.value = value
  }

  /** 外业变更进发件箱：同一实体反复修改合并为一条；delete 优先于 upsert */
  async function enqueue(
    entity: OutboxEntity,
    entityId: string,
    op: OutboxItem['op'],
    beltId?: string
  ): Promise<void> {
    const id = outboxId(entity, entityId)
    const now = Date.now()
    await db.outbox.put({
      id,
      entity,
      entityId,
      beltId,
      op,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      lastError: null
    } satisfies OutboxItem)
    scheduleAutoFlush()
  }

  function scheduleAutoFlush(): void {
    if (!online.value) return
    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      void flush()
    }, 800)
  }

  /* ------------------------------ 对账主流程 ------------------------------ */

  /**
   * 网络恢复后的全量对账：以分级账里每条样带定级单为基准，
   * 拿当前外业账重新算覆盖依据哈希，逐样带核对；新增样带建「未定级」单。
   * 在一个 rw 事务内完成，任何异常都不会留下半同步状态。
   */
  async function reconcile(): Promise<{ pendingReview: number; conflicts: number }> {
    return db.transaction(
      'rw',
      [
        db.belts,
        db.sites,
        db.reefs,
        db.corals,
        db.beltGrades,
        db.syncIssues,
        db.reefConclusions
      ],
      async () => {
        const [fieldBelts, fieldSites, fieldReefs, fieldCorals, gradeRows, issueRows, conclusions] =
          await Promise.all([
            db.belts.toArray(),
            db.sites.toArray(),
            db.reefs.toArray(),
            db.corals.toArray(),
            db.beltGrades.toArray(),
            db.syncIssues.toArray(),
            db.reefConclusions.toArray()
          ])

        const now = Date.now()
        const beltById = new Map(fieldBelts.map((belt) => [belt.id, belt]))
        const reefById = new Map(fieldReefs.map((reef) => [reef.id, reef]))
        const coralsByBelt = new Map<string, typeof fieldCorals>()
        fieldCorals.forEach((coral) => {
          const list = coralsByBelt.get(coral.beltId) ?? []
          list.push(coral)
          coralsByBelt.set(coral.beltId, list)
        })

        const gradeUpdates: BeltGrade[] = []
        const issueUpserts: Array<{ key: string; row: SyncIssue }> = []

        const openIssue = (kind: IssueKind, key: string): SyncIssue | undefined =>
          issueRows.find((row) => row.id === key && row.resolvedAt === null)
        const issueKey = (kind: IssueKind, id: string): string => `${kind}:${id}`

        const raiseIssue = (
          kind: IssueKind,
          entityId: string,
          title: string,
          detail: string,
          extra?: { beltId?: string; reefId?: string }
        ): void => {
          const key = issueKey(kind, entityId)
          const existing = openIssue(kind, key)
          if (existing) {
            existing.title = title
            existing.detail = detail
            issueUpserts.push({ key, row: existing })
          } else {
            issueUpserts.push({
              key,
              row: {
                id: key,
                kind,
                beltId: extra?.beltId,
                reefId: extra?.reefId,
                title,
                detail,
                createdAt: now,
                resolvedAt: null,
                resolution: null
              }
            })
          }
        }

        const resolveIssue = (key: string, resolution: string): void => {
          const row = issueRows.find((item) => item.id === key)
          if (row && row.resolvedAt === null) {
            row.resolvedAt = now
            row.resolution = resolution
            issueUpserts.push({ key, row })
          }
        }

        // 1) 同站位样带编号重复：按样带编号对账的前提是编号可唯一定位
        const groups = new Map<string, Belt[]>()
        fieldBelts.forEach((belt) => {
          const key = `${belt.siteId}::${belt.no}`
          const list = groups.get(key) ?? []
          list.push(belt)
          groups.set(key, list)
        })
        const gradedBeltIds = new Set(gradeRows.map((row) => row.beltId))
        groups.forEach((list) => {
          if (list.length < 2) return
          list.forEach((belt) => {
            raiseIssue(
              'duplicate-no',
              belt.id,
              `样带 ${belt.no} 在同一站位编号重复`,
              `样带 ${belt.id} 与同站位 ${list
                .filter((item) => item.id !== belt.id)
                .map((item) => item.id)
                .join('、')} 共用编号 ${belt.no}，按编号对账无法区分，请外业修改编号后重新对账。`,
              { beltId: belt.id }
            )
          })
        })
        // 已不存在重复的旧挂账自动销账
        issueRows
          .filter((issue) => issue.kind === 'duplicate-no' && issue.resolvedAt === null)
          .forEach((issue) => {
            const belt = issue.beltId ? beltById.get(issue.beltId) : undefined
            if (!belt) return
            const dup = groups.get(`${belt.siteId}::${belt.no}`)
            if (!dup || dup.length < 2) {
              resolveIssue(issue.id, '外业已修正样带编号，重新对账通过')
            }
          })

        // 2) 逐条定级单对账
        let pendingReview = 0
        let conflicts = 0
        gradeRows.forEach((grade) => {
          const belt = beltById.get(grade.beltId)

          if (!belt) {
            // 外业样带已删：分级账留底，挂分歧等人定；该样带的覆盖变更挂账随之收口
            if (grade.status !== '有分歧') {
              grade.status = '有分歧'
              grade.note = '外业账已删除该样带，等级与依据快照留底，等待人工裁定'
              grade.updatedAt = now
              gradeUpdates.push(grade)
            }
            raiseIssue(
              'belt-deleted',
              grade.beltId,
              `外业已删除样带 ${grade.beltNo}`,
              `分级账仍保留该样带${grade.grade ? `的定级「${grade.grade}」` : ''}与覆盖快照。请人工选择「删除分级账」或「留底备查」。`,
              { beltId: grade.beltId }
            )
            const coverageKey = issueKey('coverage-changed', grade.beltId)
            resolveIssue(coverageKey, '外业已删除样带，转入样带删除分歧处理')
            conflicts += 1
            return
          }

          // 刷新编号 / 站位快照（对账身份以 beltId 为准，编号仅展示）
          let changed = false
          if (grade.beltNo !== belt.no) {
            grade.beltNo = belt.no
            changed = true
          }
          if (grade.siteId !== belt.siteId) {
            grade.siteId = belt.siteId
            changed = true
          }

          const fieldCoralsOfBelt = coralsByBelt.get(belt.id) ?? []
          const currentHash = beltBasisHash(belt, fieldCoralsOfBelt)
          const coverageKey = issueKey('coverage-changed', belt.id)
          const hasOpenCoverageIssue = Boolean(openIssue('coverage-changed', coverageKey))

          if (currentHash !== grade.basisHash) {
            if (grade.status === '已定级') {
              // 核心规则：定过级的样带外业再改 → 转待复核，旧等级原封不动
              grade.status = '待复核'
              grade.note = '定级后外业补记/修改了样带属性或珊瑚覆盖，等待分级组复核'
              grade.updatedAt = now
              gradeUpdates.push(grade)
              raiseIssue(
                'coverage-changed',
                belt.id,
                `样带 ${belt.no} 覆盖依据已变更，等待复核`,
                `分级组定级时的覆盖快照与外业最新记账对不上（按样带编号 ${belt.no} 对账）。可「按新覆盖重新定级」或「维持原等级并刷新基线」。`,
                { beltId: belt.id }
              )
              pendingReview += 1
            } else if (grade.status === '未定级' && !hasOpenCoverageIssue) {
              // 尚未定级的样带怎么改都不需要复核，直接滚动基线
              grade.basisHash = currentHash
              changed = true
            } else if (grade.status === '待复核' || grade.status === '有分歧') {
              // 仍挂账中：刷新挂账描述，等级照旧
              raiseIssue(
                'coverage-changed',
                belt.id,
                `样带 ${belt.no} 覆盖依据仍有变更，等待复核`,
                `外业在挂账期间又有新补记，最新覆盖依据仍与定级快照不一致（样带编号 ${belt.no}）。请人工复核。`,
                { beltId: belt.id }
              )
              pendingReview += 1
            }
          } else if (changed) {
            grade.updatedAt = now
            gradeUpdates.push(grade)
          }
        })

        // 3) 外业新样带分级账还没有 → 建「未定级」单，基线取当前覆盖
        const newGrades: BeltGrade[] = fieldBelts
          .filter((belt) => !gradedBeltIds.has(belt.id))
          .map((belt) => ({
            beltId: belt.id,
            beltNo: belt.no,
            siteId: belt.siteId,
            status: '未定级' as const,
            basisHash: beltBasisHash(belt, coralsByBelt.get(belt.id) ?? []),
            grade: null,
            bleachIndex: null,
            gradedBy: '',
            gradedAt: null,
            note: '',
            createdAt: now,
            updatedAt: now
          }))

        // 4) 礁区结论：外业礁区已删 → 结论留底挂分歧
        conclusions.forEach((conclusion) => {
          if (reefById.has(conclusion.reefId)) return
          raiseIssue(
            'reef-deleted',
            conclusion.reefId,
            `外业已删除礁区「${conclusion.reefName}」`,
            `分级组撰写的礁区结论仍保留。请人工选择「删除结论」或「留底备查」。`,
            { reefId: conclusion.reefId }
          )
          conflicts += 1
        })

        if (gradeUpdates.length > 0) await db.beltGrades.bulkPut(gradeUpdates)
        if (newGrades.length > 0) await db.beltGrades.bulkPut(newGrades)
        if (issueUpserts.length > 0) {
          await db.syncIssues.bulkPut(issueUpserts.map((item) => item.row))
        }

        return { pendingReview, conflicts }
      }
    )
  }

  /**
   * 网络恢复后发送发件箱并对账。
   * 中断模拟打开时：不动分级账、不删发件箱，只累计 attempts/lastError 供外业重试。
   */
  async function flush(): Promise<FlushResult> {
    if (syncing.value) {
      return { ran: false, synced: 0, pendingReview: 0, conflicts: 0, cleared: 0 }
    }
    if (!online.value) {
      return { ran: false, reason: 'offline', synced: 0, pendingReview: 0, conflicts: 0, cleared: 0 }
    }
    // 直接读表：liveQuery 的 ref 更新是异步的，刚 enqueue 完立刻 flush 时 ref 可能还是旧值
    const pending = await db.outbox.toArray()
    if (pending.length === 0) {
      return { ran: false, reason: 'empty', synced: 0, pendingReview: 0, conflicts: 0, cleared: 0 }
    }

    syncing.value = true
    try {
      if (failNextFlush.value) {
        // 同步中断：发件箱留外业重试，分级组那份照旧
        const now = Date.now()
        await db.outbox.bulkPut(
          pending.map((item) => ({
            ...item,
            attempts: item.attempts + 1,
            lastError: INTERRUPTED_MESSAGE,
            updatedAt: now
          }))
        )
        lastSyncError.value = INTERRUPTED_MESSAGE
        failNextFlush.value = false
        return { ran: false, reason: 'interrupted', synced: 0, pendingReview: 0, conflicts: 0, cleared: 0 }
      }

      const result = await reconcile()

      // 对账成功：本批发件箱清空；个别实体的分歧已落到 syncIssues 等人定
      await db.outbox.bulkDelete(pending.map((item) => item.id))
      lastSyncAt.value = Date.now()
      lastSyncError.value = null
      return {
        ran: true,
        synced: pending.length,
        pendingReview: result.pendingReview,
        conflicts: result.conflicts,
        cleared: pending.length
      }
    } finally {
      syncing.value = false
    }
  }

  /** 不依赖发件箱的手动全量对账（分级组工作台「按样带重新对账」） */
  async function reconcileOnly(): Promise<FlushResult> {
    if (!online.value) return { ran: false, reason: 'offline', synced: 0, pendingReview: 0, conflicts: 0, cleared: 0 }
    syncing.value = true
    try {
      const result = await reconcile()
      lastSyncAt.value = Date.now()
      lastSyncError.value = null
      return { ran: true, synced: 0, pendingReview: result.pendingReview, conflicts: result.conflicts, cleared: 0 }
    } finally {
      syncing.value = false
    }
  }

  return {
    outbox,
    issues,
    openIssues,
    online,
    failNextFlush,
    syncing,
    lastSyncAt,
    lastSyncError,
    pendingCount,
    failedItems,
    hasFailure,
    lastAttemptAt,
    start,
    setOnline,
    setFailNextFlush,
    enqueue,
    flush,
    reconcileOnly,
    scheduleAutoFlush
  }
})
