/**
 * 升级冒烟：先按 v2 结构造一个旧库（含 corals.bleachLevel），
 * 再以 v3 打开，验证：等级迁入 assessments、beltGrades 已定级、礁区结论已补、
 * 旧 corals 行仍保留（兼容字段），且升级后改覆盖会转待复核。
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'

function assert(cond: boolean, message: string): void {
  if (!cond) {
    console.error('❌ FAIL:', message)
    process.exitCode = 1
  } else {
    console.log('✅', message)
  }
}

async function main(): Promise<void> {
  // 1) 用独立 Dexie 按 v2 建旧库
  class LegacyDb extends Dexie {
    reefs!: Dexie.Table
    sites!: Dexie.Table
    belts!: Dexie.Table
    corals!: Dexie.Table
    fishes!: Dexie.Table
    constructor() {
      super('gbcoralbelt')
      this.version(1).stores({
        reefs: 'id, name, protectStatus',
        sites: 'id, reefId, no',
        belts: 'id, siteId, no, surveyDate',
        corals: 'id, beltId, genus, form',
        fishes: 'id, beltId, family, sizeClass'
      })
      this.version(2).stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
      })
    }
  }
  const legacy = new LegacyDb()
  await legacy.open()
  const now = Date.now()
  await legacy.reefs.put({ id: 'r1', name: '旧礁区', location: '外海', areaKm2: 3, protectStatus: '核心区', manager: '旧站', createdAt: now, updatedAt: now })
  await legacy.sites.put({ id: 's1', reefId: 'r1', no: 'S-01', lat: 18, lng: 110, depthM: 5, substrate: '岩礁', createdAt: now, updatedAt: now })
  await legacy.belts.put({ id: 'b1', siteId: 's1', no: 'T-01', lengthM: 50, orientation: '北', surveyDate: '2026-09-01', observer: '旧外业', createdAt: now, updatedAt: now })
  await legacy.corals.put({ id: 'c1', beltId: 'b1', genus: '鹿角珊瑚属', form: '枝状', coverCm: 800, bleachLevel: '重', remark: '旧账白化很重', createdAt: now, updatedAt: now })
  await legacy.corals.put({ id: 'c2', beltId: 'b1', genus: '滨珊瑚属', form: '块状', coverCm: 200, bleachLevel: '无', remark: '', createdAt: now, updatedAt: now })
  await legacy.fishes.put({ id: 'f1', beltId: 'b1', family: '雀鲷科', count: 10, sizeClass: '0-10cm', category: '鱼类', createdAt: now, updatedAt: now })
  await legacy.close()

  // 2) 用应用 v3 打开同一库，触发 upgrade
  const { db, DB_VERSION } = await import('@/utils/db')
  assert(DB_VERSION === 3, '应用结构版本 v3')
  // 首次查询会隐式打开并执行 v2→v3 upgrade
  const openedVersion = await db.open().then((d) => d.verno)
  assert(openedVersion === 3, 'v3 打开旧库成功（vernos=3，已触发升级）')

  const assessments = await db.assessments.toArray()
  assert(assessments.length === 2, '旧白化等级已整体迁入 assessments（2 条）')
  const c1 = await db.assessments.get('c1')
  assert(c1?.bleachLevel === '重' && c1?.coverCm === 800, 'c1 旧等级「重」与覆盖快照保留')

  const grade = await db.beltGrades.get('b1')
  assert(grade?.status === '已定级', '旧样带升级后为已定级')
  assert(grade?.grade === '中' || grade?.grade === '重', `样带等级按加权指数换算（得 ${grade?.grade}）`)

  const conclusion = await db.reefConclusions.get('r1')
  assert(Boolean(conclusion) && conclusion!.conclusion.includes('旧数据升级补结论'), '旧礁区已自动补礁区结论')

  const legacyCoral = await db.corals.get('c1')
  assert(legacyCoral?.bleachLevel === '重', '外业 corals 兼容字段仍在（不影响分级账）')

  // 3) 升级后外业再改覆盖 → 待复核
  const { useSurveyStore } = await import('@/stores/surveyStore')
  const { useSyncStore } = await import('@/stores/syncStore')
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const survey = useSurveyStore()
  const sync = useSyncStore()
  await survey.createCoral('b1', { genus: '杯形珊瑚属', form: '枝状', coverCm: 50, remark: '升级后补记' })
  await sync.flush()
  const after = await db.beltGrades.get('b1')
  assert(after?.status === '待复核', '升级并定级后外业再改 → 转待复核')
  assert(after?.grade === grade?.grade, '待复核时等级仍是升级继承的旧等级')

  console.log(process.exitCode ? '\n存在失败用例' : '\n升级用例全部通过')
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
