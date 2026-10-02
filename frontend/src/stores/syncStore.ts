/**
 * 同步对账 store：外业份与分级份各自持有自己那份。
 * - 外业写入（样带 / 珊瑚覆盖）先进离线待同步队列（outbox），现场断网也照旧记账；
 * - 网络恢复后按样带编号（beltNo + siteNo）与分级组对账，外业改动绝不覆盖分级份；
 * - 对不上的（待复核 / 对账不符）留人工定论，分级组那份照旧；
 * - 同步中断的条目留在队列，等外业重试。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type {
  BleachGrade,
  IssueResolution,
  IssueType,
  OutboxAction,
  OutboxEntityType,
  OutboxEntry,
  ReefConclusion,
  ReconcileIssue
} from '@/types/sync'
import { parseCoverSnapshot } from '@/types/sync'
import type { BleachLevel } from '@/types/coralRecord'
import type { CoralForm } from '@/types/coralRecord'
import type { CoralRecord } from '@/types/coralRecord'
import type { Belt } from '@/types/belt'

export const useSyncStore = defineStore('sync', () => {
  const outbox = ref<OutboxEntry[]>([])
  const issues = ref<ReconcileIssue[]>([])
  const grades = ref<BleachGrade[]>([])
  const conclusions = ref<ReefConclusion[]>([])
  const online = ref(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const syncing = ref(false)
  /** 演示用：模拟链路中断，开启后对账会在投递若干条后中断，条目留待重试 */
  const simulateInterrupt = ref(false)

  let started = false
  let syncScheduled = false

  const pendingCount = computed(() => outbox.value.filter((entry) => entry.status === 'pending').length)
  const failedCount = computed(() => outbox.value.filter((entry) => entry.status === 'failed').length)
  const openIssueCount = computed(() => issues.value.filter((issue) => issue.status === 'open').length)
  const syncedCount = computed(() => outbox.value.filter((entry) => entry.status === 'synced').length)

  const openIssues = computed(() =>
    issues.value
      .filter((issue) => issue.status === 'open')
      .sort((a, b) => b.createdAt - a.createdAt)
  )

  function start(): void {
    if (started) return
    started = true
    watchTable<OutboxEntry>(() => db.outbox).subscribe((rows) => {
      outbox.value = rows.sort((a, b) => a.createdAt - b.createdAt)
    })
    watchTable<ReconcileIssue>(() => db.reconcileIssues).subscribe((rows) => {
      issues.value = rows.sort((a, b) => b.createdAt - a.createdAt)
    })
    watchTable<BleachGrade>(() => db.bleachGrades).subscribe((rows) => {
      grades.value = rows
    })
    watchTable<ReefConclusion>(() => db.reefConclusions).subscribe((rows) => {
      conclusions.value = rows
    })
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline)
      window.addEventListener('offline', handleOffline)
    }
  }

  function handleOnline(): void {
    online.value = true
    void scheduleSync()
  }

  function handleOffline(): void {
    online.value = false
  }

  /** 按样带 id 取分级组定级（分级份） */
  function gradeForBelt(beltId: string | null | undefined): BleachGrade | null {
    if (!beltId) return null
    return grades.value.find((grade) => grade.beltId === beltId) ?? null
  }

  /** 按礁区 id 取礁区结论（分级份） */
  function conclusionForReef(reefId: string | null | undefined): ReefConclusion | null {
    if (!reefId) return null
    return conclusions.value.find((conclusion) => conclusion.reefId === reefId) ?? null
  }

  /** 某样带是否有待处理的对账问题 */
  function openIssueForBelt(beltId: string | null | undefined): ReconcileIssue | null {
    if (!beltId) return null
    return issues.value.find((issue) => issue.beltId === beltId && issue.status === 'open') ?? null
  }

  /** 某样带的外业同步状态：synced / pending / failed / review（待复核）/ conflict（对账不符） */
  function beltSyncState(beltId: string | null | undefined): 'synced' | 'pending' | 'failed' | 'review' | 'conflict' {
    if (!beltId) return 'synced'
    const openIssue = openIssueForBelt(beltId)
    if (openIssue?.type === 'grade_conflict') return 'conflict'
    if (openIssue?.type === 'graded_belt_modified') return 'review'
    const failed = outbox.value.some((entry) => entry.beltId === beltId && entry.status === 'failed')
    if (failed) return 'failed'
    const pending = outbox.value.some((entry) => entry.beltId === beltId && entry.status === 'pending')
    if (pending) return 'pending'
    return 'synced'
  }

  /** 解析样带业务键（样带编号 / 站位编号 / 礁区 id），用于按样带编号对账 */
  async function resolveBeltKeys(beltId: string): Promise<{ beltNo: string; siteNo: string; reefId: string }> {
    const belt = await db.belts.get(beltId)
    if (!belt) return { beltNo: '', siteNo: '', reefId: '' }
    const site = await db.sites.get(belt.siteId)
    return { beltNo: belt.no, siteNo: site?.no ?? '', reefId: site?.reefId ?? '' }
  }

  /**
   * 外业写入入队：现场断网也照旧记账，写入先落待同步队列。
   * 同一实体的待同步条目合并为一条（保留首次旧状态用于回退）。
   * keys 为预解析的样带业务键（删除样带时样带已不存在，需提前传入）。
   */
  async function enqueue(
    entityType: OutboxEntityType,
    entityId: string,
    beltId: string,
    action: OutboxAction,
    payload: unknown,
    prevPayload: unknown,
    keys?: { beltNo: string; siteNo: string; reefId: string }
  ): Promise<void> {
    const resolved = keys ?? (await resolveBeltKeys(beltId))
    const payloadStr = JSON.stringify(payload ?? null)
    const prevStr = JSON.stringify(prevPayload ?? null)
    const existing = await db.outbox
      .filter((entry) => entry.entityId === entityId && entry.status === 'pending')
      .first()
    if (existing) {
      await db.outbox.update(existing.id, {
        action,
        beltId,
        beltNo: resolved.beltNo || existing.beltNo,
        siteNo: resolved.siteNo || existing.siteNo,
        reefId: resolved.reefId || existing.reefId,
        payload: payloadStr,
        attempts: 0,
        lastError: ''
      })
    } else {
      const entry: OutboxEntry = {
        id: createId('obx'),
        entityType,
        entityId,
        beltId,
        beltNo: resolved.beltNo,
        siteNo: resolved.siteNo,
        reefId: resolved.reefId,
        action,
        payload: payloadStr,
        prevPayload: prevStr,
        status: 'pending',
        attempts: 0,
        lastError: '',
        createdAt: Date.now(),
        syncedAt: null
      }
      await db.outbox.put(entry)
    }
    if (online.value) void scheduleSync()
  }

  /** 防抖调度一次对账（网络恢复后自动触发） */
  async function scheduleSync(): Promise<void> {
    if (syncScheduled) return
    syncScheduled = true
    setTimeout(() => {
      syncScheduled = false
      void syncNow()
    }, 350)
  }

  /**
   * 网络恢复后按样带编号与分级组对账：
   * - 已定级样带被外业改动 → 待复核 / 对账不符（分级份不被覆盖）；
   * - 未定级样带 → 正常投递，标记已同步；
   * - 链路中断 → 条目留 failed，等外业重试。
   */
  async function syncNow(): Promise<{ delivered: number; failed: number }> {
    if (syncing.value) return { delivered: 0, failed: 0 }
    syncing.value = true
    let delivered = 0
    let failed = 0
    try {
      const entries = await db.outbox
        .filter((entry) => entry.status === 'pending' || entry.status === 'failed')
        .toArray()
      entries.sort((a, b) => a.createdAt - b.createdAt)
      for (const entry of entries) {
        // 演示用：模拟链路中断，每轮投递 2 条后中断，余下留待重试
        if (simulateInterrupt.value && delivered >= 2) {
          await markFailed(entry, '同步中断（模拟链路中断），留外业重试')
          failed += 1
          break
        }
        try {
          await deliver(entry)
          delivered += 1
        } catch (err) {
          await markFailed(entry, err instanceof Error ? err.message : '同步失败，留外业重试')
          failed += 1
          break
        }
      }
    } finally {
      syncing.value = false
    }
    return { delivered, failed }
  }

  async function markFailed(entry: OutboxEntry, error: string): Promise<void> {
    await db.outbox.update(entry.id, {
      status: 'failed',
      attempts: entry.attempts + 1,
      lastError: error
    })
  }

  /** 投递单条外业改动：按样带编号对账，分级份照旧不覆盖 */
  async function deliver(entry: OutboxEntry): Promise<void> {
    const belt = await db.belts.get(entry.beltId)
    const grade = await db.bleachGrades.where('beltId').equals(entry.beltId).first()

    if (grade) {
      // 已定级样带被外业改动 → 触发对账问题，分级份不被覆盖
      const type: IssueType = entry.entityType === 'coral' ? 'grade_conflict' : 'graded_belt_modified'
      // 同一对位样带只保留一条待处理问题，合并最新外业快照
      const existing = await db.reconcileIssues
        .filter((issue) => issue.beltId === entry.beltId && issue.type === type && issue.status === 'open')
        .first()
      const fieldPayload = entry.payload
      const gradingPayload = JSON.stringify(grade)
      if (existing) {
        await db.reconcileIssues.update(existing.id, {
          fieldPayload,
          gradingPayload,
          summary: buildIssueSummary(type, entry, belt, grade)
        })
      } else {
        const issue: ReconcileIssue = {
          id: createId('iss'),
          type,
          status: 'open',
          beltId: entry.beltId,
          beltNo: entry.beltNo || grade.beltNo,
          siteNo: entry.siteNo,
          reefId: entry.reefId || grade.reefId,
          title: type === 'grade_conflict' ? '对账不符' : '待复核',
          summary: buildIssueSummary(type, entry, belt, grade),
          fieldPayload,
          gradingPayload,
          resolution: null,
          resolvedBy: '',
          createdAt: Date.now(),
          resolvedAt: null
        }
        await db.reconcileIssues.put(issue)
      }
    }

    // 投递成功：标记已同步（外业份改动已送达分级组，但分级份未被覆盖）
    await db.outbox.update(entry.id, {
      status: 'synced',
      attempts: entry.attempts + 1,
      lastError: '',
      syncedAt: Date.now()
    })
  }

  function buildIssueSummary(
    type: IssueType,
    entry: OutboxEntry,
    belt: { no?: string; lengthM?: number } | undefined,
    grade: BleachGrade
  ): string {
    const beltNo = entry.beltNo || belt?.no || grade.beltNo
    if (type === 'grade_conflict') {
      return `样带 ${beltNo} 已由分级组定为「${grade.bleachLevel}」，外业又补记/改动了珊瑚覆盖，定级依据对不上，需人工定论。`
    }
    return `样带 ${beltNo} 已由分级组定为「${grade.bleachLevel}」，外业改动了样带信息，需分级组复核。`
  }

  /** 重试失败 / 待同步条目（同步中断的留外业重试） */
  async function retryFailed(): Promise<{ delivered: number; failed: number }> {
    return syncNow()
  }

  /**
   * 人工定论：对不上的等人定，分级组那份照旧或按定论处理。
   */
  async function resolveIssue(issueId: string, resolution: IssueResolution, operator = '值班员'): Promise<void> {
    const issue = await db.reconcileIssues.get(issueId)
    if (!issue || issue.status !== 'open') return

    if (resolution === 'grading_wins' || resolution === 'revert_field') {
      // 以分级份为准：回退外业改动
      await revertFieldChange(issue)
    } else if (resolution === 'field_wins' || resolution === 'resubmit_grading') {
      // 以外业份为准 / 提交重评：作废分级定级，由分级组重新定级
      await db.bleachGrades.where('beltId').equals(issue.beltId).delete()
    }
    // manual_keep：维持现状，仅标记已核对

    await db.reconcileIssues.update(issueId, {
      status: 'resolved',
      resolution,
      resolvedBy: operator,
      resolvedAt: Date.now()
    })
  }

  /** 按分级份快照回退外业改动（覆盖改动 → 恢复珊瑚记录；样带改动 → 恢复样带头） */
  async function revertFieldChange(issue: ReconcileIssue): Promise<void> {
    const grade = await db.bleachGrades.where('beltId').equals(issue.beltId).first()
    if (!grade) return
    const now = Date.now()

    if (issue.type === 'grade_conflict') {
      // 恢复定级时的珊瑚覆盖快照
      const snapshot = parseCoverSnapshot(grade.coverSnapshot)
      await db.transaction('rw', [db.corals], async () => {
        await db.corals.where('beltId').equals(issue.beltId).delete()
        if (snapshot.length > 0) {
          const records: CoralRecord[] = snapshot.map((item, index) => ({
            id: createId('cor'),
            beltId: issue.beltId,
            genus: item.genus,
            form: item.form as CoralForm,
            coverCm: item.coverCm,
            bleachLevel: item.bleachLevel,
            remark: item.remark,
            createdAt: now + index,
            updatedAt: now + index
          }))
          await db.corals.bulkPut(records)
        }
      })
    } else {
      // 恢复定级时的样带头快照
      try {
        const snap = JSON.parse(grade.beltSnapshot) as Record<string, unknown>
        const belt = await db.belts.get(issue.beltId)
        if (belt) {
          await db.belts.update(issue.beltId, {
            no: typeof snap.no === 'string' ? snap.no : belt.no,
            lengthM: typeof snap.lengthM === 'number' ? snap.lengthM : belt.lengthM,
            orientation: (snap.orientation as Belt['orientation']) ?? belt.orientation,
            surveyDate: typeof snap.surveyDate === 'string' ? snap.surveyDate : belt.surveyDate,
            observer: typeof snap.observer === 'string' ? snap.observer : belt.observer,
            updatedAt: now
          })
        }
      } catch {
        // 快照损坏时跳过回退，保留人工定论
      }
    }
  }

  /**
   * 分级组定级（分级份）：写入权威白化等级与定级快照，外业份不被覆盖。
   * 若该样带已有待复核 / 对账不符问题，定级后视为分级组已复核，问题关闭。
   */
  async function setBeltGrade(
    beltId: string,
    bleachLevel: BleachLevel,
    conclusion: string,
    operator = '分级组'
  ): Promise<BleachGrade | null> {
    const belt = await db.belts.get(beltId)
    if (!belt) return null
    const site = await db.sites.get(belt.siteId)
    const corals = await db.corals.where('beltId').equals(beltId).toArray()
    const now = Date.now()
    const coverSnapshot = JSON.stringify(
      corals.map((coral) => ({
        genus: coral.genus,
        form: coral.form,
        coverCm: coral.coverCm,
        bleachLevel: coral.bleachLevel,
        remark: coral.remark
      }))
    )
    const beltSnapshot = JSON.stringify({
      no: belt.no,
      lengthM: belt.lengthM,
      orientation: belt.orientation,
      surveyDate: belt.surveyDate,
      observer: belt.observer
    })

    const existing = await db.bleachGrades.where('beltId').equals(beltId).first()
    if (existing) {
      await db.bleachGrades.update(existing.id, {
        bleachLevel,
        conclusion,
        coverSnapshot,
        beltSnapshot,
        gradedBy: operator,
        gradedAt: now,
        updatedAt: now
      })
    } else {
      const grade: BleachGrade = {
        id: createId('grd'),
        beltId,
        beltNo: belt.no,
        reefId: site?.reefId ?? '',
        bleachLevel,
        conclusion,
        coverSnapshot,
        beltSnapshot,
        gradedBy: operator,
        gradedAt: now,
        updatedAt: now
      }
      await db.bleachGrades.put(grade)
    }

    // 定级 / 改级后，该样带的待复核问题视为已复核关闭
    await db.reconcileIssues
      .where('beltId')
      .equals(beltId)
      .filter((issue) => issue.status === 'open')
      .modify((issue) => {
        issue.status = 'resolved'
        issue.resolution = 'resubmit_grading'
        issue.resolvedBy = operator
        issue.resolvedAt = now
      })

    return gradeForBelt(beltId)
  }

  /** 分级组出具礁区结论（分级份） */
  async function setReefConclusion(reefId: string, conclusion: string, operator = '分级组'): Promise<void> {
    const now = Date.now()
    const existing = await db.reefConclusions.where('reefId').equals(reefId).first()
    if (existing) {
      await db.reefConclusions.update(existing.id, { conclusion, updatedBy: operator, updatedAt: now })
    } else {
      await db.reefConclusions.put({
        id: createId('rcc'),
        reefId,
        conclusion,
        updatedBy: operator,
        updatedAt: now
      })
    }
  }

  return {
    outbox,
    issues,
    grades,
    conclusions,
    online,
    syncing,
    simulateInterrupt,
    pendingCount,
    failedCount,
    openIssueCount,
    syncedCount,
    openIssues,
    start,
    gradeForBelt,
    conclusionForReef,
    openIssueForBelt,
    beltSyncState,
    resolveBeltKeys,
    enqueue,
    syncNow,
    retryFailed,
    resolveIssue,
    setBeltGrade,
    setReefConclusion
  }
})
