/**
 * 端到端冒烟（Node + fake-indexeddb）：
 * 1. 播种后两套账齐全、演示样带已定级
 * 2. 断网补记：发件箱增加、分级账不动
 * 3. 同步中断：发件箱保留、attempts+1、分级账不动
 * 4. 网络恢复对账：定过级样带转待复核、挂账出现、原等级保留
 * 5. 人工重新定级：恢复已定级、挂账销账
 * 6. 删除样带：对账挂分歧、分级账留底
 */
import 'fake-indexeddb/auto'
import { db, resetDatabase, DB_VERSION } from '@/utils/db'
import { useSyncStore } from '@/stores/syncStore'
import { useGradingStore } from '@/stores/gradingStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useBeltStore } from '@/stores/beltStore'
import { createPinia, setActivePinia } from 'pinia'

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error('❌ FAIL:', message)
    process.exitCode = 1
  } else {
    console.log('✅', message)
  }
}

async function main(): Promise<void> {
  assert(DB_VERSION === 3, '结构版本为 v3')
  await resetDatabase()

  setActivePinia(createPinia())
  const sync = useSyncStore()
  const grading = useGradingStore()
  const survey = useSurveyStore()
  const belts = useBeltStore()
  sync.start()
  grading.start()
  survey.start()
  belts.start()
  await new Promise((r) => setTimeout(r, 200))

  const belt = await db.belts.toCollection().first()
  assert(Boolean(belt), '播种后存在样带')
  const beltId = belt!.id
  const before = await db.beltGrades.get(beltId)
  assert(before?.status === '已定级', `演示样带 ${belt!.no} 初始已定级`)
  const oldGrade = before!.grade

  // 2. 断网补记
  sync.setOnline(false)
  const coralsBefore = await db.corals.where('beltId').equals(beltId).toArray()
  const coverNow = coralsBefore.reduce((s, c) => s + c.coverCm, 0) + 200
  await survey.createCoral(beltId, { genus: '测试珊瑚属', form: '块状', coverCm: coverNow > belt!.lengthM * 100 ? 10 : coverNow, remark: '断网补记' })
  await new Promise((r) => setTimeout(r, 100))
  assert(sync.pendingCount >= 1, '断网补记进入发件箱')
  const gradeAfterOffline = await db.beltGrades.get(beltId)
  assert(gradeAfterOffline?.status === '已定级' && gradeAfterOffline.grade === oldGrade, '断网期间分级账等级照旧')

  // 3. 同步中断：先打开中断开关，再恢复在线；若启动定时器先跑过一次，就再补一次
  sync.setFailNextFlush(true)
  sync.setOnline(true)
  await new Promise((r) => setTimeout(r, 100))
  sync.setFailNextFlush(true)
  const interrupted = await sync.flush()
  assert(interrupted.reason === 'interrupted', '同步中断被识别')
  const failed = await db.outbox.toCollection().first()
  assert((failed?.attempts ?? 0) >= 1 && failed?.lastError !== null, '中断后发件箱留外业且 attempts+1')
  const gradeAfterInterrupt = await db.beltGrades.get(beltId)
  assert(gradeAfterInterrupt?.grade === oldGrade, '中断后分级组那份照旧')

  // 4. 恢复对账
  const result = await sync.flush()
  assert(result.ran === true && result.cleared >= 1, '恢复后发件箱发送成功')
  const gradeAfter = await db.beltGrades.get(beltId)
  assert(gradeAfter?.status === '待复核', '定过级样带外业补记后自动转待复核')
  assert(gradeAfter?.grade === oldGrade, '待复核时原等级保留')
  const issue = await db.syncIssues.get(`coverage-changed:${beltId}`)
  assert(Boolean(issue) && issue!.resolvedAt === null, '覆盖变更挂账等人定')

  // 5. 人工重新定级
  const fieldCorals = await db.corals.where('beltId').equals(beltId).toArray()
  await grading.gradeBelt(
    belt!,
    fieldCorals,
    {
      levels: Object.fromEntries(fieldCorals.map((c) => [c.id, c.bleachLevel])),
      gradedBy: '测试定级人'
    }
  )
  const regraded = await db.beltGrades.get(beltId)
  assert(regraded?.status === '已定级', '人工定级后恢复已定级')
  const issueResolved = await db.syncIssues.get(`coverage-changed:${beltId}`)
  assert(issueResolved?.resolvedAt !== null, '定级后挂账销账')

  // 6. 删除样带 → 分歧挂账
  await belts.removeBelt(beltId)
  await sync.flush()
  const deletedIssue = await db.syncIssues.get(`belt-deleted:${beltId}`)
  assert(Boolean(deletedIssue), '外业删除样带后挂分歧等人定')
  const gradeKept = await db.beltGrades.get(beltId)
  assert(gradeKept?.status === '有分歧', '删除后分级账留底为有分歧')
  const assessmentsKept = await db.assessments.where('beltId').equals(beltId).count()
  assert(assessmentsKept > 0, '删除后逐条等级快照仍留底')

  // 7. 裁定：删除分级账
  await grading.resolveDeletedBelt(beltId, 'drop-grading', '测试定级人')
  const gradeGone = await db.beltGrades.get(beltId)
  const assessGone = await db.assessments.where('beltId').equals(beltId).count()
  assert(!gradeGone && assessGone === 0, '人工裁定删除后分级账清除')
  const issueClosed = await db.syncIssues.get(`belt-deleted:${beltId}`)
  assert(issueClosed?.resolvedAt !== null, '裁定后挂账关闭')

  console.log(process.exitCode ? '\n存在失败用例' : '\n全部用例通过')
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
