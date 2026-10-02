/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbcoralbelt，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（礁区 → 站位 → 样带 → 珊瑚记录/鱼类计数）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table, type Transaction } from 'dexie'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import type { BleachGrade, OutboxEntry, ReefConclusion, ReconcileIssue } from '@/types/sync'
import { bleachGrade, bleachIndex, coralCoveragePct, round } from '@/utils/bleach'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbcoralbelt'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbcoralbelt:db-version',
  lastBackupAt: 'gbcoralbelt:last-backup-at',
  lastReefId: 'gbcoralbelt:last-reef-id'
} as const

/** 备份文件结构，供 utils/export.ts 与覆盖度汇总页使用 */
export interface BackupPayload {
  app: 'gbcoralbelt'
  dbVersion: number
  exportedAt: string
  reefs: Reef[]
  sites: Site[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
  /** 外业待同步队列（外业份） */
  outbox: OutboxEntry[]
  /** 分级组定级记录（分级份） */
  bleachGrades: BleachGrade[]
  /** 礁区结论（分级份） */
  reefConclusions: ReefConclusion[]
  /** 对账问题（待复核 / 对账不符，留人工定论） */
  reconcileIssues: ReconcileIssue[]
}

export class CoralBeltDatabase extends Dexie {
  reefs!: Table<Reef, string>
  sites!: Table<Site, string>
  belts!: Table<Belt, string>
  corals!: Table<CoralRecord, string>
  fishes!: Table<FishCount, string>
  /** 外业待同步队列 */
  outbox!: Table<OutboxEntry, string>
  /** 分级组定级记录（分级份） */
  bleachGrades!: Table<BleachGrade, string>
  /** 礁区结论（分级份） */
  reefConclusions!: Table<ReefConclusion, string>
  /** 对账问题（待人工定论） */
  reconcileIssues!: Table<ReconcileIssue, string>

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

    // v3：外业份与分级份各自持有自己那份。新增待同步队列、分级定级、礁区结论与对账问题表；
    // 升级时把历史数据补录为分级份（补结论、判定级），外业份数据保持不变。
    this.version(DB_VERSION)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt',
        outbox: 'id, entityType, entityId, beltId, beltNo, siteNo, status, createdAt',
        bleachGrades: 'id, beltId, beltNo, reefId, bleachLevel, gradedAt',
        reefConclusions: 'id, reefId, updatedAt',
        reconcileIssues: 'id, type, status, beltId, beltNo, reefId, createdAt'
      })
      .upgrade(async (tx) => {
        await backfillGradingCopies(tx)
      })
  }
}

export const db = new CoralBeltDatabase()

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

/* ------------------------------ v3 迁移：补录分级份 ------------------------------ */

/**
 * 旧数据升级时补结论、判定级：
 * 把历史上「外业份与分级份共用一条记录」时期的数据，按样带补录为分级组定级（bleachGrades），
 * 按礁区补录礁区结论（reefConclusions）。外业份（belts / corals）原样保留，不覆盖、不删除。
 * 幂等：分级份已有记录时跳过。
 */
async function backfillGradingCopies(tx: Transaction): Promise<void> {
  const gradeTable = tx.table('bleachGrades')
  const conclusionTable = tx.table('reefConclusions')
  const existingGrades = await gradeTable.count()
  const existingConclusions = await conclusionTable.count()
  if (existingGrades > 0 && existingConclusions > 0) return

  const reefs = (await tx.table('reefs').toArray()) as Reef[]
  const sites = (await tx.table('sites').toArray()) as Site[]
  const belts = (await tx.table('belts').toArray()) as Belt[]
  const corals = (await tx.table('corals').toArray()) as CoralRecord[]
  const now = Date.now()

  const siteById = new Map(sites.map((site) => [site.id, site]))
  const coralsByBelt = new Map<string, CoralRecord[]>()
  corals.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })

  // 按样带补录分级定级
  if (existingGrades === 0) {
    const grades: BleachGrade[] = []
    for (const belt of belts) {
      const beltCorals = coralsByBelt.get(belt.id) ?? []
      if (beltCorals.length === 0) continue
      const site = siteById.get(belt.siteId)
      const index = bleachIndex(beltCorals)
      const level = bleachGrade(index)
      const coverTotal = round(
        beltCorals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
      grades.push({
        id: createId('grd'),
        beltId: belt.id,
        beltNo: belt.no,
        reefId: site?.reefId ?? '',
        bleachLevel: level,
        conclusion: `升级补录：珊瑚覆盖率 ${coralCoveragePct(coverTotal, belt.lengthM)}%，白化指数 ${index}（${level}）`,
        coverSnapshot: JSON.stringify(
          beltCorals.map((coral) => ({
            genus: coral.genus,
            form: coral.form,
            coverCm: coral.coverCm,
            remark: coral.remark
          }))
        ),
        beltSnapshot: JSON.stringify({
          no: belt.no,
          lengthM: belt.lengthM,
          orientation: belt.orientation,
          surveyDate: belt.surveyDate,
          observer: belt.observer
        }),
        gradedBy: '系统补录',
        gradedAt: belt.updatedAt || now,
        updatedAt: now
      })
    }
    if (grades.length > 0) await gradeTable.bulkPut(grades)
  }

  // 按礁区补录结论
  if (existingConclusions === 0) {
    const conclusions: ReefConclusion[] = reefs.map((reef) => {
      const reefSiteIds = new Set(sites.filter((site) => site.reefId === reef.id).map((site) => site.id))
      const reefBelts = belts.filter((belt) => reefSiteIds.has(belt.siteId))
      const reefBeltIds = new Set(reefBelts.map((belt) => belt.id))
      const reefCorals = corals.filter((coral) => reefBeltIds.has(coral.beltId))
      const coverTotal = round(
        reefCorals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
      const avgIndex =
        reefBelts.length === 0
          ? 0
          : round(
              reefBelts.reduce((sum, belt) => {
                const list = coralsByBelt.get(belt.id) ?? []
                return sum + bleachIndex(list)
              }, 0) / reefBelts.length,
              2
            )
      const level = bleachGrade(avgIndex)
      const conclusion =
        reefBelts.length === 0
          ? `升级补录：礁区「${reef.name}」暂无样带与珊瑚记录，待外业开展普查后出具结论。`
          : `升级补录：礁区「${reef.name}」共 ${reefSiteIds.size} 个站位、${reefBelts.length} 条样带，珊瑚覆盖率 ${coralCoveragePct(coverTotal, reefBelts.reduce((sum, belt) => sum + belt.lengthM, 0))}%，平均白化指数 ${avgIndex}（${level}）。`
      return {
        id: createId('rcc'),
        reefId: reef.id,
        conclusion,
        updatedBy: '系统补录',
        updatedAt: now
      }
    })
    if (conclusions.length > 0) await conclusionTable.bulkPut(conclusions)
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

/**
 * 播种演示数据：3 个礁区 → 4 个站位 → 5 条样带 → 14 条珊瑚记录 + 12 条鱼类计数，
 * 覆盖无 / 轻 / 中 / 重 / 死亡 全部白化等级，保证每个页面打开都有内容、层级路由也能命中真实 id。
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

  await db.transaction('rw', [db.reefs, db.sites, db.belts, db.corals, db.fishes], async () => {
    const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
      createdAt: now + offset,
      updatedAt: now + offset
    })

    await db.reefs.bulkPut(reefs.map((reef, index) => ({ ...reef, ...stamp(index) })))
    await db.sites.bulkPut(sites.map((site, index) => ({ ...site, ...stamp(100 + index) })))
    await db.belts.bulkPut(
      belts.map((belt, index) => {
        const { corals, fishes, ...rest } = belt
        void corals
        void fishes
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
  })
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

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.outbox, db.bleachGrades, db.reefConclusions, db.reconcileIssues],
    async () => {
      await Promise.all([
        db.reefs.clear(),
        db.sites.clear(),
        db.belts.clear(),
        db.corals.clear(),
        db.fishes.clear(),
        db.outbox.clear(),
        db.bleachGrades.clear(),
        db.reefConclusions.clear(),
        db.reconcileIssues.clear()
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
  const [reefs, sites, belts, corals, fishes, outbox, bleachGrades, reefConclusions, reconcileIssues] =
    await Promise.all([
      db.reefs.count(),
      db.sites.count(),
      db.belts.count(),
      db.corals.count(),
      db.fishes.count(),
      db.outbox.count(),
      db.bleachGrades.count(),
      db.reefConclusions.count(),
      db.reconcileIssues.count()
    ])
  return { reefs, sites, belts, corals, fishes, outbox, bleachGrades, reefConclusions, reconcileIssues }
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
