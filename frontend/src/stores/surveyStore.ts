/**
 * 普查 store（外业账）：维护珊瑚覆盖与鱼类计数的筛选、录入草稿。
 * 覆盖 /belts/:id/corals、/belts/:id/fishes。
 *
 * v3 起白化等级不归外业：本 store 不再算等级 / 指数 / 分布，那些一律读分级组账（gradingStore）。
 * 外业对珊瑚覆盖的任何增删改都进断网发件箱（syncStore），现场断网照旧记账、恢复后按样带对账。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import { useSyncStore } from '@/stores/syncStore'
import type { CoralForm, CoralRecord } from '@/types/coralRecord'
import type { CountCategory, FishCount, SizeClass } from '@/types/fishCount'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import { coralCoveragePct, round } from '@/utils/bleach'

/** 外业珊瑚记录写入载荷（不含白化等级） */
export type CoralInput = Omit<CoralRecord, 'id' | 'createdAt' | 'updatedAt' | 'beltId' | 'bleachLevel'>

export const useSurveyStore = defineStore('survey', () => {
  const corals = ref<CoralRecord[]>([])
  const fishes = ref<FishCount[]>([])
  const reefs = ref<Reef[]>([])
  const sites = ref<Site[]>([])
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  /** 珊瑚覆盖录入草稿（外业只录覆盖，白化等级去分级工作台定） */
  const coralDraft = ref({
    genus: '',
    form: '枝状' as CoralForm,
    coverCm: 100,
    remark: ''
  })
  /** 鱼类计数草稿 */
  const fishDraft = ref({
    family: '',
    count: 1,
    sizeClass: '11-20cm' as SizeClass,
    category: '鱼类' as CountCategory
  })

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<CoralRecord>(() => db.corals).subscribe((rows) => {
      corals.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<FishCount>(() => db.fishes).subscribe((rows) => {
      fishes.value = rows
    })
    watchTable<Reef>(() => db.reefs).subscribe((rows) => {
      reefs.value = rows
    })
    watchTable<Site>(() => db.sites).subscribe((rows) => {
      sites.value = rows
    })
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
    })
  }

  /** 某样带的珊瑚覆盖记录（覆盖长度降序；等级不在外业账排序口径里） */
  function coralsOfBelt(beltId: string | null | undefined): CoralRecord[] {
    if (!beltId) return []
    return corals.value
      .filter((coral) => coral.beltId === beltId)
      .sort((a, b) => b.coverCm - a.coverCm)
  }

  /** 某样带的鱼类/无脊椎动物计数 */
  function fishesOfBelt(beltId: string | null | undefined): FishCount[] {
    if (!beltId) return []
    return fishes.value
      .filter((fish) => fish.beltId === beltId)
      .sort((a, b) => b.count - a.count)
  }

  /** 样带 id → 珊瑚记录数 / 鱼类记录数（样带列表回显用） */
  const beltRecordCounts = computed<Record<string, { coralCount: number; fishCount: number }>>(() => {
    const counts: Record<string, { coralCount: number; fishCount: number }> = {}
    belts.value.forEach((belt) => {
      counts[belt.id] = {
        coralCount: corals.value.filter((coral) => coral.beltId === belt.id).length,
        fishCount: fishes.value.filter((fish) => fish.beltId === belt.id).length
      }
    })
    return counts
  })

  /** 外业口径的样带覆盖行（只含覆盖率等外业指标；白化等级取分级账，见 gradingStore） */
  const coverageRows = computed(() =>
    belts.value
      .map((belt) => {
        const site = sites.value.find((item) => item.id === belt.siteId)
        const reef = site ? reefs.value.find((item) => item.id === site.reefId) : undefined
        const beltCorals = corals.value.filter((coral) => coral.beltId === belt.id)
        const beltFishes = fishes.value.filter((fish) => fish.beltId === belt.id)
        const coverCmTotal = round(
          beltCorals.reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        )
        const fishTotal = beltFishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
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
          coralCount: beltCorals.length,
          coverCmTotal,
          coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
          fishTotal,
          invertebrateTotal: beltFishes
            .filter((fish) => fish.category === '无脊椎动物')
            .reduce((sum, fish) => sum + fish.count, 0),
          fishDensity: belt.lengthM > 0 ? round((fishTotal / belt.lengthM) * 100, 2) : 0
        }
      })
  )

  function patchCoralDraft(patch: Partial<typeof coralDraft.value>): void {
    coralDraft.value = { ...coralDraft.value, ...patch }
  }

  function patchFishDraft(patch: Partial<typeof fishDraft.value>): void {
    fishDraft.value = { ...fishDraft.value, ...patch }
  }

  /* ------------------------------ 珊瑚覆盖（外业） ------------------------------ */

  async function createCoral(beltId: string, payload: CoralInput): Promise<CoralRecord> {
    const now = Date.now()
    // bleachLevel 固定「无」占位：等级归分级账，外业写入不带任何等级语义
    const row: CoralRecord = { ...payload, beltId, bleachLevel: '无', id: createId('cor'), createdAt: now, updatedAt: now }
    await db.corals.put(row)
    await useSyncStore().enqueue('coral', row.id, 'upsert', beltId)
    return row
  }

  async function updateCoral(id: string, patch: Partial<CoralInput>): Promise<void> {
    await db.corals.update(id, { ...patch, updatedAt: Date.now() } as never)
    const row = corals.value.find((coral) => coral.id === id)
    await useSyncStore().enqueue('coral', id, 'upsert', row?.beltId)
  }

  async function removeCoral(id: string): Promise<void> {
    const row = corals.value.find((coral) => coral.id === id)
    const beltId = row?.beltId
    await db.corals.delete(id)
    await useSyncStore().enqueue('coral', id, 'delete', beltId)
  }

  /** 批量导入粘贴行（替换该样带原有珊瑚覆盖记录；白化等级一律不录） */
  async function importCoralRows(
    beltId: string,
    rows: Array<{ genus: string; form: CoralForm; coverCm: number }>
  ): Promise<number> {
    const now = Date.now()
    const sync = useSyncStore()
    const records: CoralRecord[] = rows.map((row, index) => ({
      id: createId('cor'),
      beltId,
      genus: row.genus,
      form: row.form,
      coverCm: row.coverCm,
      bleachLevel: '无',
      remark: '',
      createdAt: now + index,
      updatedAt: now + index
    }))
    const oldIds = corals.value.filter((coral) => coral.beltId === beltId).map((coral) => coral.id)
    await db.transaction('rw', [db.corals], async () => {
      await db.corals.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.corals.bulkPut(records)
    })
    // 旧记录删、新记录增都进箱；同箱内按实体合并，对账最终以整样带哈希为准
    for (const oldId of oldIds) {
      await sync.enqueue('coral', oldId, 'delete', beltId)
    }
    for (const record of records) {
      await sync.enqueue('coral', record.id, 'upsert', beltId)
    }
    return records.length
  }

  /* ------------------------------ 鱼类计数（外业） ------------------------------ */

  async function createFish(
    beltId: string,
    payload: Omit<FishCount, 'id' | 'createdAt' | 'updatedAt' | 'beltId'>
  ): Promise<FishCount> {
    const now = Date.now()
    const row: FishCount = { ...payload, beltId, id: createId('fsh'), createdAt: now, updatedAt: now }
    await db.fishes.put(row)
    return row
  }

  async function updateFish(id: string, patch: Partial<FishCount>): Promise<void> {
    await db.fishes.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeFish(id: string): Promise<void> {
    await db.fishes.delete(id)
  }

  /** 批量导入粘贴行（替换该样带原有计数） */
  async function importFishRows(
    beltId: string,
    rows: Array<{ family: string; count: number; sizeClass: SizeClass; category: CountCategory }>
  ): Promise<number> {
    const now = Date.now()
    const records: FishCount[] = rows.map((row, index) => ({
      id: createId('fsh'),
      beltId,
      family: row.family,
      count: row.count,
      sizeClass: row.sizeClass,
      category: row.category,
      createdAt: now + index,
      updatedAt: now + index
    }))
    await db.transaction('rw', [db.fishes], async () => {
      await db.fishes.where('beltId').equals(beltId).delete()
      if (records.length > 0) await db.fishes.bulkPut(records)
    })
    return records.length
  }

  /** 按科名与体长段汇总某样带计数 */
  function fishSummaryOfBelt(beltId: string | null | undefined): Array<{
    family: string
    category: CountCategory
    total: number
    bySize: Record<SizeClass, number>
  }> {
    if (!beltId) return []
    const map = new Map<string, { family: string; category: CountCategory; total: number; bySize: Record<SizeClass, number> }>()
    fishesOfBelt(beltId).forEach((fish) => {
      const bucket =
        map.get(fish.family) ??
        { family: fish.family, category: fish.category, total: 0, bySize: { '0-10cm': 0, '11-20cm': 0, '21-30cm': 0, '>30cm': 0 } }
      bucket.total += fish.count
      bucket.bySize[fish.sizeClass] += fish.count
      map.set(fish.family, bucket)
    })
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  }

  return {
    corals,
    fishes,
    reefs,
    sites,
    belts,
    ready,
    error,
    coralDraft,
    fishDraft,
    beltRecordCounts,
    coverageRows,
    start,
    coralsOfBelt,
    fishesOfBelt,
    fishSummaryOfBelt,
    patchCoralDraft,
    patchFishDraft,
    createCoral,
    updateCoral,
    removeCoral,
    importCoralRows,
    createFish,
    updateFish,
    removeFish,
    importFishRows
  }
})
