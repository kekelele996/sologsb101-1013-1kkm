/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 以及按礁区/样带汇总的覆盖度结论生成。
 *
 * v3 快照含两套账：外业账（reefs/sites/belts/corals/fishes）+ 分级账
 * （assessments/beltGrades/reefConclusions）；本地断网发件箱 outbox / syncIssues
 * 属设备本地传输状态，不进快照。覆盖导入会重建两套账并重新生成对账基线。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import {
  BLEACH_LEVELS,
  type BleachLevel
} from '@/types/coralRecord'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'
import type { Assessment, BeltGrade, ReefConclusion } from '@/types/grading'
import { beltBasisHash } from '@/utils/basis'
import { MIGRATION_GRADER } from '@/types/grading'
import { backfillGradingLedger } from '@/utils/db'

/** 备份集合键名（外业账五表 + 分级账三表） */
export const BACKUP_KEYS = [
  'reefs',
  'sites',
  'belts',
  'corals',
  'fishes',
  'assessments',
  'beltGrades',
  'reefConclusions'
] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

export function emptyCountMap(): CountMap {
  return {
    reefs: 0,
    sites: 0,
    belts: 0,
    corals: 0,
    fishes: 0,
    assessments: 0,
    beltGrades: 0,
    reefConclusions: 0
  }
}

/** 组装当前本地数据的完整快照（外业账 + 分级账） */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [reefs, sites, belts, corals, fishes, assessments, beltGrades, reefConclusions] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.belts.toArray(),
    db.corals.toArray(),
    db.fishes.toArray(),
    db.assessments.toArray(),
    db.beltGrades.toArray(),
    db.reefConclusions.toArray()
  ])
  return {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    reefs,
    sites,
    belts,
    corals,
    fishes,
    assessments,
    beltGrades,
    reefConclusions
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件；v3 要求两套账齐全（旧 v2 备份做兼容补空） */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== undefined && obj.app !== 'gbcoralbelt') {
    errors.push('app 字段应为 gbcoralbelt，文件来源不明')
  }
  // 外业账五表必须有；分级账三表允许旧备份缺失（导入时重建）
  for (const key of ['reefs', 'sites', 'belts', 'corals', 'fishes'] as const) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: obj.reefs ?? [],
    sites: obj.sites ?? [],
    belts: obj.belts ?? [],
    corals: obj.corals ?? [],
    fishes: obj.fishes ?? [],
    assessments: Array.isArray(obj.assessments) ? obj.assessments : [],
    beltGrades: Array.isArray(obj.beltGrades) ? obj.beltGrades : [],
    reefConclusions: Array.isArray(obj.reefConclusions) ? obj.reefConclusions : []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    reefs: payload.reefs.length,
    sites: payload.sites.length,
    belts: payload.belts.length,
    corals: payload.corals.length,
    fishes: payload.fishes.length,
    assessments: payload.assessments.length,
    beltGrades: payload.beltGrades.length,
    reefConclusions: payload.reefConclusions.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/**
 * 导入快照：overwrite=true 先清空全部本地表（含发件箱），否则按主键合并。
 * 合并 / 覆盖后以当前外业账重新生成缺失样带的定级基线，保证导入数据也能走对账流程。
 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [
      db.reefs,
      db.sites,
      db.belts,
      db.corals,
      db.fishes,
      db.assessments,
      db.beltGrades,
      db.reefConclusions
    ],
    async () => {
      await db.reefs.bulkPut(payload.reefs)
      await db.sites.bulkPut(payload.sites)
      await db.belts.bulkPut(payload.belts)
      await db.corals.bulkPut(payload.corals)
      await db.fishes.bulkPut(payload.fishes)
      await db.assessments.bulkPut(payload.assessments)
      await db.beltGrades.bulkPut(payload.beltGrades)
      await db.reefConclusions.bulkPut(payload.reefConclusions)

      // 旧版 v2 备份没有分级账：用旧 corals.bleachLevel 回填分级账并补礁区结论（与库升级同口径）
      const isLegacyV2 =
        payload.assessments.length === 0 &&
        payload.beltGrades.length === 0 &&
        payload.reefConclusions.length === 0 &&
        payload.corals.some((coral) => typeof coral.bleachLevel === 'string')
      if (isLegacyV2 && overwrite) {
        await backfillGradingLedger(db, MIGRATION_GRADER, true)
      }

      // 追加导入 / 快照里仍缺定级单的样带：补「未定级」基线，等分级组定级
      const existing = new Set((await db.beltGrades.toArray()).map((row) => row.beltId))
      const now = Date.now()
      const missing: BeltGrade[] = payload.belts
        .filter((belt) => !existing.has(belt.id))
        .map((belt) => ({
          beltId: belt.id,
          beltNo: belt.no,
          siteId: belt.siteId,
          status: '未定级' as const,
          basisHash: beltBasisHash(
            belt,
            payload.corals.filter((coral) => coral.beltId === belt.id)
          ),
          grade: null,
          bleachIndex: null,
          gradedBy: '',
          gradedAt: null,
          note: '备份导入补建，尚未定级',
          createdAt: now,
          updatedAt: now
        }))
      if (missing.length > 0) await db.beltGrades.bulkPut(missing)
    }
  )
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案；分级账 id 跟随外业账重映射 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()
  const coralMap = new Map<string, string>()

  const reefs = payload.reefs.map((reef) => {
    const id = createId('reef')
    reefMap.set(reef.id, id)
    return { ...reef, id }
  })
  const sites = payload.sites.map((site) => {
    const id = createId('site')
    siteMap.set(site.id, id)
    return { ...site, id, reefId: reefMap.get(site.reefId) ?? site.reefId }
  })
  const belts = payload.belts.map((belt) => {
    const id = createId('belt')
    beltMap.set(belt.id, id)
    return { ...belt, id, siteId: siteMap.get(belt.siteId) ?? belt.siteId }
  })
  const corals = payload.corals.map((coral) => {
    const id = createId('cor')
    coralMap.set(coral.id, id)
    return { ...coral, id, beltId: beltMap.get(coral.beltId) ?? coral.beltId }
  })
  const fishes = payload.fishes.map((fish) => ({
    ...fish,
    id: createId('fsh'),
    beltId: beltMap.get(fish.beltId) ?? fish.beltId
  }))
  // 分级快照：assessment 主键随外业珊瑚 id 重映射（定级是逐条对记录的）
  const assessments: Assessment[] = payload.assessments
    .filter((row) => coralMap.has(row.id) && beltMap.has(row.beltId))
    .map((row) => ({
      ...row,
      id: coralMap.get(row.id) ?? row.id,
      beltId: beltMap.get(row.beltId) ?? row.beltId
    }))
  const beltGrades: BeltGrade[] = payload.beltGrades
    .filter((row) => beltMap.has(row.beltId))
    .map((row) => ({ ...row, beltId: beltMap.get(row.beltId) ?? row.beltId }))
  const reefConclusions: ReefConclusion[] = payload.reefConclusions
    .filter((row) => reefMap.has(row.reefId))
    .map((row) => ({ ...row, reefId: reefMap.get(row.reefId) ?? row.reefId }))
  return { ...payload, reefs, sites, belts, corals, fishes, assessments, beltGrades, reefConclusions }
}

/** 白化等级分布：各等级累计覆盖长度（分级快照口径） */
export type BleachDistribution = Record<BleachLevel, number>

/** 覆盖度结论行：按样带汇总珊瑚覆盖率、白化占比与鱼类密度；白化一律取分级账 */
export interface CoverageLine {
  beltId: string
  beltNo: string
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  coralCount: number
  coverCmTotal: number
  /** 珊瑚覆盖率（%） */
  coveragePct: number
  /** 白化指数 0 ~ 4（分级账快照） */
  bleachIndex: number
  /** 总体白化等级（分级账定级；未定级为 null） */
  grade: BleachLevel | null
  /** 定级状态：未定级 / 已定级 / 待复核 / 有分歧 */
  gradeStatus: BeltGrade['status']
  /** 白化占比（%，分级快照覆盖长度加权） */
  bleachedSharePct: number
  distribution: BleachDistribution
  fishTotal: number
  invertebrateTotal: number
  /** 鱼类密度（尾 / 100 m²） */
  fishDensity: number
  conclusion: string
}

/** 按样带生成覆盖度结论行：覆盖取外业账、白化等级取分级账 */
export function buildCoverageLines(payload: BackupPayload): CoverageLine[] {
  const reefById = new Map(payload.reefs.map((reef) => [reef.id, reef]))
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const coralsByBelt = new Map<string, typeof payload.corals>()
  payload.corals.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })
  const assessmentsByBelt = new Map<string, Assessment[]>()
  payload.assessments.forEach((assessment) => {
    const list = assessmentsByBelt.get(assessment.beltId) ?? []
    list.push(assessment)
    assessmentsByBelt.set(assessment.beltId, list)
  })
  const gradeByBelt = new Map(payload.beltGrades.map((grade) => [grade.beltId, grade]))
  const fishesByBelt = new Map<string, typeof payload.fishes>()
  payload.fishes.forEach((fish) => {
    const list = fishesByBelt.get(fish.beltId) ?? []
    list.push(fish)
    fishesByBelt.set(fish.beltId, list)
  })

  return payload.belts
    .map((belt) => {
      const site = siteById.get(belt.siteId)
      const reef = site ? reefById.get(site.reefId) : undefined
      const corals = coralsByBelt.get(belt.id) ?? []
      const graded = assessmentsByBelt.get(belt.id) ?? []
      const gradeRow = gradeByBelt.get(belt.id)
      const fishes = fishesByBelt.get(belt.id) ?? []
      const coverCmTotal = round(
        corals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
      const index = bleachIndex(graded)
      const distribution: BleachDistribution = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
      BLEACH_LEVELS.forEach((level) => {
        distribution[level] = round(
          graded.filter((row) => row.bleachLevel === level).reduce((sum, row) => sum + row.coverCm, 0),
          1
        )
      })
      const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
      const invertebrateTotal = fishes
        .filter((fish) => fish.category === '无脊椎动物')
        .reduce((sum, fish) => sum + fish.count, 0)
      const coveragePct = coralCoveragePct(coverCmTotal, belt.lengthM)
      const share = bleachedSharePct(graded)
      const status = gradeRow?.status ?? '未定级'
      const grade = gradeRow?.grade ?? null
      let conclusion: string
      if (corals.length === 0) conclusion = '该样带尚未录入珊瑚覆盖记录'
      else if (status === '未定级') conclusion = `珊瑚覆盖率 ${coveragePct}%，白化等级待分级组定级，暂不能上报`
      else if (status === '待复核')
        conclusion = `珊瑚覆盖率 ${coveragePct}%，原定级${grade ? `「${grade}」` : ''}挂起待复核（外业补记后覆盖依据已变更）`
      else if (status === '有分歧') conclusion = `珊瑚覆盖率 ${coveragePct}%，外业与分级账对账分歧未裁定，暂不能上报`
      else if (grade === '无') conclusion = `珊瑚覆盖率 ${coveragePct}%，未见白化`
      else conclusion = `珊瑚覆盖率 ${coveragePct}%，白化指数 ${index}（${grade}），白化占比 ${share}%`
      return {
        beltId: belt.id,
        beltNo: belt.no,
        reefId: reef?.id ?? '',
        reefName: reef?.name ?? '未知礁区',
        siteId: site?.id ?? '',
        siteNo: site?.no ?? '—',
        lengthM: belt.lengthM,
        orientation: belt.orientation,
        surveyDate: belt.surveyDate,
        observer: belt.observer,
        coralCount: corals.length,
        coverCmTotal,
        coveragePct,
        bleachIndex: index,
        grade,
        gradeStatus: status,
        bleachedSharePct: share,
        distribution,
        fishTotal,
        invertebrateTotal,
        fishDensity: fishDensity(fishTotal, belt.lengthM),
        conclusion
      }
    })
    .sort((a, b) => b.bleachIndex - a.bleachIndex)
}

/** 按礁区汇总：站位/样带数量、平均白化指数与总体等级（指数取分级账定级行） */
export interface ReefSummary {
  reefId: string
  reefName: string
  protectStatus: string
  siteCount: number
  beltCount: number
  coralCount: number
  coverCmTotal: number
  avgBleachIndex: number
  grade: BleachLevel | null
  /** 已定级 / 待复核 / 有分歧 / 未定级 样带数 */
  statusCounts: Record<BeltGrade['status'], number>
  fishTotal: number
}

export function buildReefSummaries(payload: BackupPayload, lines: CoverageLine[]): ReefSummary[] {
  return payload.reefs.map((reef) => {
    const siteIds = new Set(payload.sites.filter((site) => site.reefId === reef.id).map((site) => site.id))
    const beltIds = new Set(payload.belts.filter((belt) => siteIds.has(belt.siteId)).map((belt) => belt.id))
    const corals = payload.corals.filter((coral) => beltIds.has(coral.beltId))
    const lines4Reef = lines.filter((line) => line.reefId === reef.id)
    const gradedLines = lines4Reef.filter((line) => line.gradeStatus === '已定级')
    const avgBleachIndex =
      gradedLines.length === 0
        ? 0
        : round(gradedLines.reduce((sum, line) => sum + line.bleachIndex, 0) / gradedLines.length, 2)
    const statusCounts: Record<BeltGrade['status'], number> = {
      未定级: 0,
      已定级: 0,
      待复核: 0,
      有分歧: 0
    }
    lines4Reef.forEach((line) => {
      statusCounts[line.gradeStatus] += 1
    })
    return {
      reefId: reef.id,
      reefName: reef.name,
      protectStatus: reef.protectStatus,
      siteCount: siteIds.size,
      beltCount: beltIds.size,
      coralCount: corals.length,
      coverCmTotal: round(
        corals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      ),
      avgBleachIndex,
      grade: gradedLines.length > 0 ? bleachGrade(avgBleachIndex) : null,
      statusCounts,
      fishTotal: payload.fishes
        .filter((fish) => beltIds.has(fish.beltId))
        .reduce((sum, fish) => sum + fish.count, 0)
    }
  })
}
