/**
 * 分级 store：分级组独占写的分级账（assessments / beltGrades / reefConclusions）
 * 与外业账物理隔离——这里的任何写入都不碰 corals；外业覆盖补记也不碰这里。
 *
 * 定级时把当前外业覆盖拍快照进 assessments（分级组自己留底的那份），
 * 并在 beltGrades 记录覆盖依据哈希；之后外业再改覆盖，对账层只会把样带转待复核，等级照旧。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, watchTable } from '@/utils/db'
import type {
  Assessment,
  BeltGrade,
  IssueResolution,
  ReefConclusion,
  SyncIssue
} from '@/types/grading'
import type { BleachLevel } from '@/types/coralRecord'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import { beltBasisHash } from '@/utils/basis'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, round } from '@/utils/bleach'

export interface GradingInput {
  /** 珊瑚记录 id → 分级组定的白化等级（未出现的记录沿用既有等级，新增记录默认「无」） */
  levels: Record<string, BleachLevel>
  gradedBy: string
  note?: string
}

export const useGradingStore = defineStore('grading', () => {
  const assessments = ref<Assessment[]>([])
  const beltGrades = ref<BeltGrade[]>([])
  const reefConclusions = ref<ReefConclusion[]>([])
  const issues = ref<SyncIssue[]>([])
  const ready = ref(false)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Assessment>(() => db.assessments).subscribe((rows) => {
      assessments.value = rows
      ready.value = true
    })
    watchTable<BeltGrade>(() => db.beltGrades).subscribe((rows) => {
      beltGrades.value = rows
    })
    watchTable<ReefConclusion>(() => db.reefConclusions).subscribe((rows) => {
      reefConclusions.value = rows
    })
    watchTable<SyncIssue>(() => db.syncIssues).subscribe((rows) => {
      issues.value = rows
    })
  }

  const gradeByBelt = computed<Map<string, BeltGrade>>(() => new Map(beltGrades.value.map((row) => [row.beltId, row])))
  const conclusionByReef = computed<Map<string, ReefConclusion>>(
    () => new Map(reefConclusions.value.map((row) => [row.reefId, row]))
  )
  const openIssues = computed(() =>
    issues.value.filter((issue) => issue.resolvedAt === null).sort((a, b) => b.createdAt - a.createdAt)
  )

  function assessmentsOfBelt(beltId: string): Assessment[] {
    return assessments.value
      .filter((row) => row.beltId === beltId)
      .sort((a, b) => b.coverCm - a.coverCm)
  }

  function gradeOfBelt(beltId: string | null | undefined): BeltGrade | null {
    if (!beltId) return null
    return gradeByBelt.value.get(beltId) ?? null
  }

  function conclusionOfReef(reefId: string | null | undefined): ReefConclusion | null {
    if (!reefId) return null
    return conclusionByReef.value.get(reefId) ?? null
  }

  /**
   * 分级组提交样带定级 / 复核结果：
   * 以当前外业覆盖为准拍快照，覆盖依据哈希滚动到最新；
   * 待复核样带一经定级恢复「已定级」，对应的覆盖变更挂账销账。
   */
  async function gradeBelt(belt: Belt, corals: CoralRecord[], input: GradingInput): Promise<BeltGrade> {
    const now = Date.now()
    const levelOf = (coral: CoralRecord): BleachLevel => input.levels[coral.id] ?? '无'
    const snapshotRows: Assessment[] = corals.map((coral) => ({
      id: coral.id,
      beltId: belt.id,
      genus: coral.genus,
      form: coral.form,
      coverCm: coral.coverCm,
      bleachLevel: levelOf(coral),
      gradedBy: input.gradedBy,
      gradedAt: now,
      createdAt: now,
      updatedAt: now
    }))

    const leveled = corals.map((coral) => ({ coverCm: coral.coverCm, bleachLevel: levelOf(coral) }))
    const index = bleachIndex(leveled)

    await db.transaction('rw', [db.assessments, db.beltGrades, db.syncIssues], async () => {
      // 快照整表替换该样带，天然清掉外业已删记录的残留等级
      await db.assessments.where('beltId').equals(belt.id).delete()
      if (snapshotRows.length > 0) await db.assessments.bulkPut(snapshotRows)

      await db.beltGrades.put({
        beltId: belt.id,
        beltNo: belt.no,
        siteId: belt.siteId,
        status: '已定级',
        basisHash: beltBasisHash(belt, corals),
        grade: bleachGrade(index),
        bleachIndex: index,
        gradedBy: input.gradedBy,
        gradedAt: now,
        note: input.note ?? '',
        createdAt: now,
        updatedAt: now
      } satisfies BeltGrade)

      // 覆盖变更挂账随人工定级销账（删除分歧仍由裁定动作单独处理）
      const key = `coverage-changed:${belt.id}`
      const issue = await db.syncIssues.get(key)
      if (issue && issue.resolvedAt === null) {
        await db.syncIssues.put({
          ...issue,
          resolvedAt: now,
          resolution: `分级组已按最新覆盖重新定级（${input.gradedBy}）`
        })
      }
    })

    return (await db.beltGrades.get(belt.id)) as BeltGrade
  }

  /** 待复核样带人工选择「维持原等级」：滚动对账基线，恢复已定级，等级不变 */
  async function keepOldGrade(
    belt: Belt,
    corals: CoralRecord[],
    gradedBy: string
  ): Promise<void> {
    const now = Date.now()
    const current = await db.beltGrades.get(belt.id)
    const index = current?.bleachIndex ?? bleachIndex(assessmentsOfBelt(belt.id))
    await db.transaction('rw', [db.beltGrades, db.syncIssues], async () => {
      await db.beltGrades.put({
        beltId: belt.id,
        beltNo: belt.no,
        siteId: belt.siteId,
        status: '已定级',
        basisHash: beltBasisHash(belt, corals),
        grade: current?.grade ?? null,
        bleachIndex: current?.bleachIndex ?? index,
        gradedBy: current?.gradedBy || gradedBy,
        gradedAt: current?.gradedAt ?? now,
        note: `维持原等级，外业覆盖补记已确认（${gradedBy}）`,
        createdAt: current?.createdAt ?? now,
        updatedAt: now
      } satisfies BeltGrade)
      const key = `coverage-changed:${belt.id}`
      const issue = await db.syncIssues.get(key)
      if (issue && issue.resolvedAt === null) {
        await db.syncIssues.put({
          ...issue,
          resolvedAt: now,
          resolution: `人工维持原等级并刷新对账基线（${gradedBy}）`
        })
      }
    })
  }

  /** 分级组撰写 / 修改礁区结论 */
  async function saveReefConclusion(
    reefId: string,
    reefName: string,
    conclusion: string,
    gradedBy: string
  ): Promise<void> {
    const now = Date.now()
    const existing = await db.reefConclusions.get(reefId)
    await db.reefConclusions.put({
      reefId,
      reefName,
      conclusion,
      gradedBy,
      gradedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    } satisfies ReefConclusion)

    // 若该礁区有「外业已删礁区」挂账，重新撰写说明人已介入，但删除分歧仍以裁定按钮收口
    const key = `reef-deleted:${reefId}`
    const issue = await db.syncIssues.get(key)
    if (issue && issue.resolvedAt === null) {
      await db.syncIssues.put({ ...issue, detail: `${issue.detail}（分级组刚更新过结论，请继续裁定外业删除如何处理）` })
    }
  }

  /* ------------------------------ 人工裁定 ------------------------------ */

  /** 外业删除分歧：连带删除分级账，或留底备查（有分歧） */
  async function resolveDeletedBelt(beltId: string, resolution: Extract<IssueResolution, 'drop-grading' | 'keep-grading'>, operator: string): Promise<void> {
    const now = Date.now()
    await db.transaction('rw', [db.assessments, db.beltGrades, db.syncIssues], async () => {
      const issue = await db.syncIssues.get(`belt-deleted:${beltId}`)
      if (resolution === 'drop-grading') {
        await db.assessments.where('beltId').equals(beltId).delete()
        await db.beltGrades.delete(beltId)
      } else {
        const grade = await db.beltGrades.get(beltId)
        if (grade) {
          await db.beltGrades.put({
            ...grade,
            status: '有分歧',
            note: `外业已删样带，分级账人工留底备查（${operator}）`,
            updatedAt: now
          })
        }
      }
      if (issue && issue.resolvedAt === null) {
        await db.syncIssues.put({
          ...issue,
          resolvedAt: now,
          resolution: resolution === 'drop-grading' ? `人工删除分级账（${operator}）` : `人工留底备查（${operator}）`
        })
      }
    })
  }

  /** 礁区删除分歧：删除礁区结论，或留底（结论行继续存在并标有分歧） */
  async function resolveDeletedReef(reefId: string, resolution: Extract<IssueResolution, 'drop-grading' | 'keep-grading'>, operator: string): Promise<void> {
    const now = Date.now()
    await db.transaction('rw', [db.reefConclusions, db.syncIssues], async () => {
      const issue = await db.syncIssues.get(`reef-deleted:${reefId}`)
      if (resolution === 'drop-grading') {
        await db.reefConclusions.delete(reefId)
      }
      if (issue && issue.resolvedAt === null) {
        await db.syncIssues.put({
          ...issue,
          resolvedAt: now,
          resolution: resolution === 'drop-grading' ? `人工删除礁区结论（${operator}）` : `人工留底备查（${operator}）`
        })
      }
    })
  }

  /** 编号重复：外业改完编号后人工触发重新对账（关闭挂账，下一轮对账按新编号重建） */
  async function resolveDuplicateNo(beltId: string, operator: string): Promise<void> {
    const now = Date.now()
    const issue = await db.syncIssues.get(`duplicate-no:${beltId}`)
    if (issue && issue.resolvedAt === null) {
      await db.syncIssues.put({
        ...issue,
        resolvedAt: now,
        resolution: `外业已修正编号，人工确认重新对账（${operator}）`
      })
    }
  }

  /* --------------------------- 分级账派生汇总（上报口径） --------------------------- */

  /** 分级账某样带的等级分布（按分级快照 coverCm 加权）——上报礁区情况只认这一份 */
  function gradedDistribution(beltId: string): Record<BleachLevel, number> {
    const result: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
    assessmentsOfBelt(beltId).forEach((row) => {
      result[row.bleachLevel] = round(result[row.bleachLevel] + row.coverCm, 1)
    })
    return result
  }

  /** 分级账某样带指数 / 覆盖率（覆盖率取外业样带长度与分级快照覆盖，等级取分级账） */
  function gradedBeltStats(belt: Belt | null | undefined, beltId: string): {
    bleachIndex: number
    grade: BleachLevel | null
    bleachedSharePct: number
    coveragePct: number
    coverCmTotal: number
  } {
    const rows = assessmentsOfBelt(beltId)
    const index = bleachIndex(rows)
    const coverCmTotal = round(rows.reduce((sum, row) => sum + row.coverCm, 0), 1)
    const gradeRow = gradeOfBelt(beltId)
    return {
      bleachIndex: index,
      grade: gradeRow?.grade ?? (rows.length > 0 ? bleachGrade(index) : null),
      bleachedSharePct: bleachedSharePct(rows),
      coveragePct: belt ? coralCoveragePct(coverCmTotal, belt.lengthM) : 0,
      coverCmTotal
    }
  }

  return {
    assessments,
    beltGrades,
    reefConclusions,
    issues,
    openIssues,
    ready,
    start,
    assessmentsOfBelt,
    gradeOfBelt,
    conclusionOfReef,
    gradeBelt,
    keepOldGrade,
    saveReefConclusion,
    resolveDeletedBelt,
    resolveDeletedReef,
    resolveDuplicateNo,
    gradedDistribution,
    gradedBeltStats
  }
})
