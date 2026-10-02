/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbcoralbelt，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（礁区 → 站位 → 样带 → 珊瑚记录/鱼类计数）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 *
 * v3 起「外业账」与「分级账」物理分表：
 * - 外业账：reefs / sites / belts / corals / fishes，只由外业队写入（样带布设、覆盖补记）
 * - 分级账：assessments / beltGrades / reefConclusions，只由分级组写入（白化等级、样带定级、礁区结论）
 * - 对账层：outbox（断网发件箱，网络恢复后重放）、syncIssues（对不上的挂账等人定）
 * 外业任何覆盖补记都不会覆盖分级账；两边按样带稳定 id（样带编号对账）核对。
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import type { Assessment, BeltGrade, OutboxItem, ReefConclusion, SyncIssue } from '@/types/grading'
import { MIGRATION_GRADER } from '@/types/grading'
import { beltBasisHash } from '@/utils/basis'
import { bleachGrade, bleachIndex, round } from '@/utils/bleach'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbcoralbelt'

/** 外业账表名（外业队独占写） */
export const FIELD_KEYS = ['reefs', 'sites', 'belts', 'corals', 'fishes'] as const
/** 分级账表名（分级组独占写） */
export const GRADING_KEYS = ['assessments', 'beltGrades', 'reefConclusions'] as const
/** 本地对账传输表（随设备本地，不进备份快照） */
export const TRANSPORT_KEYS = ['outbox', 'syncIssues'] as const

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbcoralbelt:db-version',
  lastBackupAt: 'gbcoralbelt:last-backup-at',
  lastReefId: 'gbcoralbelt:last-reef-id',
  online: 'gbcoralbelt:sync-online'
} as const

/** 备份文件结构，供 utils/export.ts 与覆盖度汇总页使用（含外业账 + 分级账，不含本地发件箱） */
export interface BackupPayload {
  app: 'gbcoralbelt'
  dbVersion: number
  exportedAt: string
  reefs: Reef[]
  sites: Site[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
  assessments: Assessment[]
  beltGrades: BeltGrade[]
  reefConclusions: ReefConclusion[]
}

export class CoralBeltDatabase extends Dexie {
  reefs!: Table<Reef, string>
  sites!: Table<Site, string>
  belts!: Table<Belt, string>
  corals!: Table<CoralRecord, string>
  fishes!: Table<FishCount, string>
  assessments!: Table<Assessment, string>
  beltGrades!: Table<BeltGrade, string>
  reefConclusions!: Table<ReefConclusion, string>
  outbox!: Table<OutboxItem, string>
  syncIssues!: Table<SyncIssue, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      reefs: 'id, name, protectStatus',
      sites: 'id, reefId, no',
      belts: 'id, siteId, no, surveyDate',
      corals: 'id, beltId, genus, form',
      fishes: 'id, beltId, family, sizeClass'
    })

    // v2：补齐筛选与统计需要的索引（位置/面积、经纬度/水深、样带长度与朝向、白化等级、类别）
    this.version(2)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与必填字段，避免列表排序与筛选拿到 undefined
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['reefs', () => ({ manager: '', areaKm2: 0 })],
          ['sites', () => ({ lat: 0, lng: 0, depthM: 5, substrate: '珊瑚礁石' })],
          ['belts', () => ({ lengthM: 50, orientation: '北', observer: '' })],
          ['corals', () => ({ coverCm: 0, bleachLevel: '无', remark: '' })],
          ['fishes', () => ({ count: 0, sizeClass: '11-20cm', category: '鱼类' })]
        ]
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, factory())
            })
        }
      })

    // v3：外业账 / 分级账分表。新增分级账、断网发件箱与对账挂账，索引按对账与筛选路径设计。
    this.version(DB_VERSION)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt',
        assessments: 'id, beltId, bleachLevel, gradedBy, gradedAt',
        beltGrades: 'beltId, beltNo, siteId, status, grade, gradedBy, gradedAt',
        reefConclusions: 'reefId, gradedBy, gradedAt',
        outbox: 'id, entity, entityId, beltId, updatedAt',
        syncIssues: 'id, kind, beltId, reefId, resolvedAt'
      })
      .upgrade(async (tx) => {
        // 旧账拆分：corals.bleachLevel 整体移交分级组（assessments + beltGrades），
        // 外业 corals.bleachLevel 仅作历史兼容字段保留、外业界面不再可写；
        // 同时为每个礁区补一条礁区结论（旧数据升级补结论）。
        const scope = {
          reefs: tx.table('reefs'),
          sites: tx.table('sites'),
          belts: tx.table('belts'),
          corals: tx.table('corals'),
          assessments: tx.table('assessments'),
          beltGrades: tx.table('beltGrades'),
          reefConclusions: tx.table('reefConclusions')
        } as unknown as GradingScope
        await backfillGradingLedger(scope, MIGRATION_GRADER, true)
      })
  }
}

export const db = new CoralBeltDatabase()

/** 生成分级账所需的最小表集合（db 实例与升级事务均满足） */
export interface GradingScope {
  reefs: Pick<Table<Reef, string>, 'toArray'>
  sites: Pick<Table<Site, string>, 'toArray'>
  belts: Pick<Table<Belt, string>, 'toArray'>
  corals: Pick<Table<CoralRecord, string>, 'toArray'>
  assessments: Pick<Table<Assessment, string>, 'bulkPut'>
  beltGrades: Pick<Table<BeltGrade, string>, 'bulkPut'>
  reefConclusions: Pick<Table<ReefConclusion, string>, 'bulkPut'>
}

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCoral {
  id: string
  beltId: string
  genus: string
  form: CoralRecord['form']
  coverCm: number
  bleachLevel: CoralRecord['bleachLevel']
  remark: string
}

interface SeedFish {
  id: string
  beltId: string
  family: string
  count: number
  sizeClass: FishCount['sizeClass']
  category: FishCount['category']
}

interface SeedBelt {
  id: string
  siteId: string
  no: string
  lengthM: number
  orientation: Belt['orientation']
  surveyDate: string
  observer: string
  corals: SeedCoral[]
  fishes: SeedFish[]
}

/** 演示数据下分级组的定级人署名 */
export const SEED_GRADER = '分级组·沈定级'

/**
 * 回填分级账：把当前外业账里的白化等级整体搬到 assessments / beltGrades，
 * 并按礁区样带汇总补 reefConclusions。升级迁移与首次播种共用，幂等（bulkPut 定长主键）。
 *
 * @param fromMigration true=旧数据升级补结论，结论文案标注「待分级组复核」
 */
export async function backfillGradingLedger(
  scope: GradingScope,
  grader: string,
  fromMigration: boolean
): Promise<void> {
  const [reefs, sites, belts, corals] = await Promise.all([
    scope.reefs.toArray(),
    scope.sites.toArray(),
    scope.belts.toArray(),
    scope.corals.toArray()
  ])
  const now = Date.now()

  const coralsByBelt = new Map<string, CoralRecord[]>()
  corals.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })

  // 逐条白化等级归分级账（记录 id 与外业珊瑚记录一致，逐条对账不串台）
  const assessments: Assessment[] = corals.map((coral) => ({
    id: coral.id,
    beltId: coral.beltId,
    genus: coral.genus,
    form: coral.form,
    coverCm: coral.coverCm,
    bleachLevel: coral.bleachLevel,
    gradedBy: grader,
    gradedAt: now,
    createdAt: now,
    updatedAt: now
  }))

  // 样带定级单：有覆盖记录才按快照定级；空样带保持「未定级」（升级后外业补录再定级）
  const beltGrades: BeltGrade[] = belts.map((belt) => {
    const list = coralsByBelt.get(belt.id) ?? []
    const index = bleachIndex(list)
    const hasCover = list.length > 0
    return {
      beltId: belt.id,
      beltNo: belt.no,
      siteId: belt.siteId,
      status: hasCover ? '已定级' : '未定级',
      basisHash: beltBasisHash(belt, list),
      grade: hasCover ? bleachGrade(index) : null,
      bleachIndex: hasCover ? index : null,
      gradedBy: hasCover ? grader : '',
      gradedAt: hasCover ? now : null,
      note: hasCover ? '' : '旧数据升级：尚无珊瑚覆盖记录，待外业补录后定级',
      createdAt: now,
      updatedAt: now
    }
  })

  // 礁区结论：按本礁区样带定级结果汇总；旧数据升级时额外标注待复核
  const sitesByReef = new Map(reefs.map((reef) => [reef.id, sites.filter((site) => site.reefId === reef.id)]))
  const gradesByBelt = new Map(beltGrades.map((grade) => [grade.beltId, grade]))
  const reefConclusions: ReefConclusion[] = reefs.map((reef) => {
    const reefSites = sitesByReef.get(reef.id) ?? []
    const siteIds = new Set(reefSites.map((site) => site.id))
    const reefBelts = belts.filter((belt) => siteIds.has(belt.siteId))
    const grades = reefBelts
      .map((belt) => gradesByBelt.get(belt.id))
      .filter((grade): grade is BeltGrade => grade !== undefined && grade.bleachIndex !== null)
    const avg = grades.length === 0 ? 0 : round(grades.reduce((sum, grade) => sum + (grade.bleachIndex ?? 0), 0) / grades.length, 2)
    const grade = grades.length === 0 ? null : bleachGrade(avg)
    const conclusion = fromMigration
      ? `旧数据升级补结论：本礁区 ${reefBelts.length} 条样带中 ${grades.length} 条已随旧账继承白化等级${
          grade ? `，平均白化指数 ${avg}（${grade}）` : ''
        }；请分级组复核后再对外上报。`
      : `按本礁区 ${grades.length} 条已定级样带汇总${grade ? `：平均白化指数 ${avg}（${grade}），` : '（暂无定级样带），'}可作为本期礁区上报结论。`
    return {
      reefId: reef.id,
      reefName: reef.name,
      conclusion,
      gradedBy: grader,
      gradedAt: now,
      createdAt: now,
      updatedAt: now
    }
  })

  await scope.assessments.bulkPut(assessments)
  await scope.beltGrades.bulkPut(beltGrades)
  await scope.reefConclusions.bulkPut(reefConclusions)
}

/**
 * 播种演示数据：3 个礁区 → 4 个站位 → 5 条样带 → 14 条珊瑚记录 + 12 条鱼类计数，
 * 覆盖无 / 轻 / 中 / 重 / 死亡 全部白化等级；同时回填分级账，保证每个页面打开都有内容。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)

  const reefs: Array<Omit<Reef, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'reef_ql01',
      name: '清澜湾珊瑚礁区',
      location: '海南文昌清澜湾东侧 3.5 km 海域',
      areaKm2: 18.6,
      protectStatus: '核心区',
      manager: '清澜湾海洋保护站'
    },
    {
      id: 'reef_yr02',
      name: '永兴岛西侧礁盘',
      location: '西沙永兴岛西侧礁盘外缘',
      areaKm2: 42.3,
      protectStatus: '缓冲区',
      manager: '西沙海洋环境监测中心'
    },
    {
      id: 'reef_dz03',
      name: '大洲岛南岸礁区',
      location: '万宁大洲岛南岸潮下带',
      areaKm2: 6.4,
      protectStatus: '实验区',
      manager: '大洲岛国家级自然保护区管理处'
    }
  ]

  const sites: Array<Omit<Site, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'site_ql_01',
      reefId: 'reef_ql01',
      no: 'S-01',
      lat: 19.5621,
      lng: 110.7924,
      depthM: 4.2,
      substrate: '珊瑚礁石'
    },
    {
      id: 'site_ql_02',
      reefId: 'reef_ql01',
      no: 'S-02',
      lat: 19.5487,
      lng: 110.8103,
      depthM: 8.6,
      substrate: '礁砂'
    },
    {
      id: 'site_yr_01',
      reefId: 'reef_yr02',
      no: 'S-01',
      lat: 16.8342,
      lng: 112.3286,
      depthM: 12.4,
      substrate: '砾石'
    },
    {
      id: 'site_dz_01',
      reefId: 'reef_dz03',
      no: 'S-01',
      lat: 18.6712,
      lng: 110.4913,
      depthM: 6.8,
      substrate: '岩礁'
    }
  ]

  const belts: SeedBelt[] = [
    {
      id: 'belt_ql01_a',
      siteId: 'site_ql_01',
      no: 'T-01',
      lengthM: 50,
      orientation: '北',
      surveyDate: today,
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01a_1', beltId: 'belt_ql01_a', genus: '鹿角珊瑚属', form: '枝状', coverCm: 860, bleachLevel: '无', remark: '长势良好' },
        { id: 'cor_ql01a_2', beltId: 'belt_ql01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 540, bleachLevel: '轻', remark: '局部褪色' },
        { id: 'cor_ql01a_3', beltId: 'belt_ql01_a', genus: '滨珊瑚属', form: '块状', coverCm: 1120, bleachLevel: '无', remark: '' },
        { id: 'cor_ql01a_4', beltId: 'belt_ql01_a', genus: '软珊瑚属', form: '软珊瑚', coverCm: 380, bleachLevel: '轻', remark: '' }
      ],
      fishes: [
        { id: 'fsh_ql01a_1', beltId: 'belt_ql01_a', family: '雀鲷科', count: 46, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_ql01a_2', beltId: 'belt_ql01_a', family: '蝴蝶鱼科', count: 18, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01a_3', beltId: 'belt_ql01_a', family: '鹦嘴鱼科', count: 7, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01a_4', beltId: 'belt_ql01_a', family: '海胆科', count: 12, sizeClass: '0-10cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_ql01_b',
      siteId: 'site_ql_01',
      no: 'T-02',
      lengthM: 50,
      orientation: '东',
      surveyDate: today,
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01b_1', beltId: 'belt_ql01_b', genus: '蔷薇珊瑚属', form: '叶状', coverCm: 720, bleachLevel: '中', remark: '边缘白化明显' },
        { id: 'cor_ql01b_2', beltId: 'belt_ql01_b', genus: '蜂巢珊瑚属', form: '块状', coverCm: 980, bleachLevel: '轻', remark: '' },
        { id: 'cor_ql01b_3', beltId: 'belt_ql01_b', genus: '鹿角珊瑚属', form: '枝状', coverCm: 430, bleachLevel: '重', remark: '大面积白化，部分死亡' }
      ],
      fishes: [
        { id: 'fsh_ql01b_1', beltId: 'belt_ql01_b', family: '隆头鱼科', count: 22, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01b_2', beltId: 'belt_ql01_b', family: '刺尾鱼科', count: 15, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01b_3', beltId: 'belt_ql01_b', family: '砗磲科', count: 3, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_ql02_a',
      siteId: 'site_ql_02',
      no: 'T-01',
      lengthM: 30,
      orientation: '南',
      surveyDate: today,
      observer: '周渝',
      corals: [
        { id: 'cor_ql02a_1', beltId: 'belt_ql02_a', genus: '滨珊瑚属', form: '块状', coverCm: 1240, bleachLevel: '无', remark: '' },
        { id: 'cor_ql02a_2', beltId: 'belt_ql02_a', genus: '陀螺珊瑚属', form: '块状', coverCm: 260, bleachLevel: '死亡', remark: '仅存骨骼，附着藻类' }
      ],
      fishes: [
        { id: 'fsh_ql02a_1', beltId: 'belt_ql02_a', family: '石斑鱼科', count: 4, sizeClass: '>30cm', category: '鱼类' },
        { id: 'fsh_ql02a_2', beltId: 'belt_ql02_a', family: '海参科', count: 6, sizeClass: '21-30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_yr01_a',
      siteId: 'site_yr_01',
      no: 'T-01',
      lengthM: 100,
      orientation: '西',
      surveyDate: today,
      observer: '陈立群',
      corals: [
        { id: 'cor_yr01a_1', beltId: 'belt_yr01_a', genus: '星珊瑚属', form: '块状', coverCm: 1580, bleachLevel: '轻', remark: '' },
        { id: 'cor_yr01a_2', beltId: 'belt_yr01_a', genus: '柳珊瑚属', form: '软珊瑚', coverCm: 640, bleachLevel: '中', remark: '水流较强区域' },
        { id: 'cor_yr01a_3', beltId: 'belt_yr01_a', genus: '石芝珊瑚属', form: '叶状', coverCm: 480, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_yr01a_1', beltId: 'belt_yr01_a', family: '笛鲷科', count: 28, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_yr01a_2', beltId: 'belt_yr01_a', family: '篮子鱼科', count: 11, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_yr01a_3', beltId: 'belt_yr01_a', family: '法螺科', count: 2, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_dz01_a',
      siteId: 'site_dz_01',
      no: 'T-01',
      lengthM: 25,
      orientation: '东',
      surveyDate: today,
      observer: '陈立群',
      corals: [
        { id: 'cor_dz01a_1', beltId: 'belt_dz01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 520, bleachLevel: '重', remark: '受台风扰动后白化' },
        { id: 'cor_dz01a_2', beltId: 'belt_dz01_a', genus: '蜂巢珊瑚属', form: '块状', coverCm: 310, bleachLevel: '中', remark: '' }
      ],
      fishes: [
        { id: 'fsh_dz01a_1', beltId: 'belt_dz01_a', family: '雀鲷科', count: 34, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_dz01a_2', beltId: 'belt_dz01_a', family: '海星科', count: 5, sizeClass: '11-20cm', category: '无脊椎动物' }
      ]
    }
  ]

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
      db.reefConclusions,
      db.outbox,
      db.syncIssues
    ],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset
      })

      await db.reefs.bulkPut(reefs.map((reef, index) => ({ ...reef, ...stamp(index) })))
      await db.sites.bulkPut(sites.map((site, index) => ({ ...site, ...stamp(100 + index) })))
      await db.belts.bulkPut(
        belts.map((belt, index) => {
          const { corals: seedCorals, fishes: seedFishes, ...rest } = belt
          void seedCorals
          void seedFishes
          return { ...rest, ...stamp(200 + index) }
        })
      )
      await db.corals.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.corals.map((coral, coralIndex) => ({ ...coral, ...stamp(300 + beltIndex * 100 + coralIndex) }))
        )
      )
      await db.fishes.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.fishes.map((fish, fishIndex) => ({ ...fish, ...stamp(400 + beltIndex * 100 + fishIndex) }))
        )
      )

      // 分级账与外业账同事务回填，演示数据打开即「两边账齐、已定级」
      await backfillGradingLedger(db, SEED_GRADER, false)
      await db.outbox.clear()
      await db.syncIssues.clear()
    }
  )
}

/** 打开数据库并幂等播种：仅当礁区表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.reefs.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部本地表（导入覆盖与重置共用：外业账、分级账与本地对账队列一并清空） */
export async function clearAllTables(): Promise<void> {
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
      db.reefConclusions,
      db.outbox,
      db.syncIssues
    ],
    async () => {
      await Promise.all([
        db.reefs.clear(),
        db.sites.clear(),
        db.belts.clear(),
        db.corals.clear(),
        db.fishes.clear(),
        db.assessments.clear(),
        db.beltGrades.clear(),
        db.reefConclusions.clear(),
        db.outbox.clear(),
        db.syncIssues.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与覆盖度页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [reefs, sites, belts, corals, fishes, assessments, beltGrades, reefConclusions, outbox, syncIssues] =
    await Promise.all([
      db.reefs.count(),
      db.sites.count(),
      db.belts.count(),
      db.corals.count(),
      db.fishes.count(),
      db.assessments.count(),
      db.beltGrades.count(),
      db.reefConclusions.count(),
      db.outbox.count(),
      db.syncIssues.filter((issue) => issue.resolvedAt === null).count()
    ])
  return { reefs, sites, belts, corals, fishes, assessments, beltGrades, reefConclusions, outbox, syncIssues }
}

/** 写入结构版本号到 localStorage，便于覆盖度页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastReefId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastReefId)
  } catch {
    return null
  }
}

export function writeLastReefId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastReefId)
    else localStorage.setItem(LS_KEYS.lastReefId, id)
  } catch {
    // 忽略
  }
}
