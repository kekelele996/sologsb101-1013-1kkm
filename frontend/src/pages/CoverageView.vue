<script setup lang="ts">
/**
 * 模块 6：/coverage 外业覆盖度汇总
 * 按样带汇总外业珊瑚覆盖率与鱼类密度；白化指数 / 等级一律读分级组账（只读），
 * 并明确展示定级状态（未定级 / 已定级 / 待复核 / 有分歧）。
 * 结构版本查看、两套账全量 JSON 导入导出也在本页。
 * 定级、对账与礁区结论请到 /grading 分级组工作台。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadFile } from 'element-plus'
import { Download, Refresh, Upload } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import { buildQuery, queryToArray, queryToBool } from '@/types/filter'
import BleachTag from '@/components/common/BleachTag.vue'
import GradeStatusTag from '@/components/common/GradeStatusTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useGradingStore } from '@/stores/gradingStore'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { BleachLevel } from '@/types/coralRecord'
import { BLEACH_COLOR, bleachGrade, bleachIndex, round } from '@/utils/bleach'
import {
  DB_NAME,
  DB_VERSION,
  countAll,
  readLastBackupAt,
  readStampedDbVersion,
  resetDatabase,
  type BackupPayload
} from '@/utils/db'
import {
  buildBackupPayload,
  buildCoverageLines,
  buildReefSummaries,
  countPayload,
  emptyCountMap,
  exportBackupJson,
  importBackup,
  readFileText,
  remapIds,
  validateBackup,
  type CountMap,
  type ReefSummary
} from '@/utils/export'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()
const gradingStore = useGradingStore()

const counts = ref<CountMap>(emptyCountMap())
const lastBackupAt = ref<string | null>(null)
const stampedVersion = ref<number>(DB_VERSION)
const reefSummaries = ref<ReefSummary[]>([])
const overwriteOnImport = ref(true)
const fileList = ref<UploadFile[]>([])
const busy = ref(false)
const notice = ref('')

const filter = reactive({
  keyword: '',
  reefIds: [] as string[],
  bleachLevels: [] as BleachLevel[],
  onlyBleached: false
})

const filterModel = computed<FilterModel>(() => ({
  keyword: filter.keyword,
  reefIds: filter.reefIds,
  bleachLevels: filter.bleachLevels
}))

interface CoverageRow {
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
  coveragePct: number
  bleachIndex: number
  grade: BleachLevel | null
  gradeStatus: '未定级' | '已定级' | '待复核' | '有分歧'
  bleachedSharePct: number
  distribution: Record<BleachLevel, number>
  fishTotal: number
  invertebrateTotal: number
  fishDensity: number
}

const allRows = computed<CoverageRow[]>(() =>
  surveyStore.coverageRows
    .map((row): CoverageRow => {
      const belt = beltStore.beltById(row.beltId)
      const graded = gradingStore.gradedBeltStats(belt, row.beltId)
      return {
        ...row,
        bleachIndex: graded.bleachIndex,
        grade: graded.grade,
        gradeStatus: gradingStore.gradeOfBelt(row.beltId)?.status ?? '未定级',
        bleachedSharePct: graded.bleachedSharePct,
        distribution: gradingStore.gradedDistribution(row.beltId)
      }
    })
    .sort((a, b) => b.bleachIndex - a.bleachIndex)
)

const rows = computed(() =>
  allRows.value.filter((row) => {
    const keyword = filter.keyword.trim()
    if (keyword.length > 0) {
      const haystack = `${row.reefName}${row.siteNo}${row.beltNo}${row.observer}`
      if (!haystack.includes(keyword)) return false
    }
    if (filter.reefIds.length > 0 && !filter.reefIds.includes(row.reefId)) return false
    if (filter.bleachLevels.length > 0) {
      const matched = filter.bleachLevels.some((level) => row.distribution[level] > 0)
      if (!matched) return false
    }
    if (filter.onlyBleached && row.bleachedSharePct <= 0) return false
    return true
  })
)

const totals = computed(() => ({
  belts: rows.value.length,
  coralCount: rows.value.reduce((sum, row) => sum + row.coralCount, 0),
  coverCmTotal: rows.value.reduce((sum, row) => sum + row.coverCmTotal, 0),
  fishTotal: rows.value.reduce((sum, row) => sum + row.fishTotal, 0),
  avgCoveragePct:
    rows.value.length === 0
      ? 0
      : round(rows.value.reduce((sum, row) => sum + row.coveragePct, 0) / rows.value.length, 2),
  graded: rows.value.filter((row) => row.gradeStatus === '已定级').length,
  pending: rows.value.filter((row) => row.gradeStatus === '待复核').length,
  conflict: rows.value.filter((row) => row.gradeStatus === '有分歧').length,
  bleachedBelts: rows.value.filter((row) => row.bleachedSharePct > 0).length
}))

/** 当前筛选结果内的白化等级分布（分级账快照口径） */
const distribution = computed<Record<BleachLevel, number>>(() => {
  const result: Record<BleachLevel, number> = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
  BLEACH_LEVELS.forEach((level) => {
    result[level] = Number(rows.value.reduce((sum, row) => sum + row.distribution[level], 0).toFixed(1))
  })
  return result
})

const distributionTotal = computed(() => BLEACH_LEVELS.reduce((sum, level) => sum + distribution.value[level], 0))

/** 全局分级账指数（只看已定级快照） */
const globalGraded = computed(() => {
  const index = bleachIndex(gradingStore.assessments)
  return {
    index,
    grade: bleachGrade(index),
    gradedBelts: gradingStore.beltGrades.filter((row) => row.status === '已定级').length,
    totalBelts: gradingStore.beltGrades.length
  }
})

function barPercent(value: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0%'
  return `${Math.min(100, (value / total) * 100).toFixed(1)}%`
}

async function refresh(): Promise<void> {
  const allCounts = await countAll()
  counts.value = {
    reefs: allCounts.reefs,
    sites: allCounts.sites,
    belts: allCounts.belts,
    corals: allCounts.corals,
    fishes: allCounts.fishes,
    assessments: allCounts.assessments,
    beltGrades: allCounts.beltGrades,
    reefConclusions: allCounts.reefConclusions
  }
  lastBackupAt.value = readLastBackupAt()
  stampedVersion.value = readStampedDbVersion()
  const payload = await buildBackupPayload()
  reefSummaries.value = buildReefSummaries(payload, buildCoverageLines(payload))
}

function handleFilterChange(): void {
  void router.replace({
    query: buildQuery({
      kw: filter.keyword,
      reef: filter.reefIds,
      level: filter.bleachLevels,
      bleached: filter.onlyBleached
    })
  })
}

function handleReset(): void {
  filter.keyword = ''
  filter.reefIds = []
  filter.bleachLevels = []
  filter.onlyBleached = false
  void router.replace({ query: {} })
}

async function handleExport(): Promise<void> {
  busy.value = true
  try {
    const result = await exportBackupJson()
    await refresh()
    notice.value = `已导出 ${result.fileName}（外业账 + 分级账共 ${Object.values(result.counts).reduce((sum, value) => sum + value, 0)} 条记录）。`
    ElMessage.success(notice.value)
  } finally {
    busy.value = false
  }
}

async function handleImport(): Promise<void> {
  const file = fileList.value[0]?.raw
  if (!file) {
    ElMessage.warning('请先选择备份 JSON 文件')
    return
  }
  busy.value = true
  try {
    const text = await readFileText(file)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      ElMessage.error('文件不是合法的 JSON，无法解析')
      return
    }
    const validation = validateBackup(parsed)
    if (!validation.ok || !validation.payload) {
      ElMessage.error(`备份校验失败：${validation.errors.join('；')}`)
      return
    }
    const payload: BackupPayload = overwriteOnImport.value ? validation.payload : remapIds(validation.payload)
    const summary = countPayload(payload)
    await ElMessageBox.confirm(
      `将导入外业账 + 分级账 ${Object.entries(summary)
        .map(([key, value]) => `${key} ${value} 条`)
        .join('、')}；${overwriteOnImport.value ? '覆盖模式会先清空本地两套账与发件箱' : '追加模式会重新分配 id 保留现有数据'}。确认继续？`,
      '导入确认',
      { type: 'warning', confirmButtonText: '继续导入', cancelButtonText: '取消' }
    )
    await importBackup(payload, overwriteOnImport.value)
    await refresh()
    notice.value = '导入完成：外业账与分级账已分别写入，请到分级组工作台对账。'
    ElMessage.success(notice.value)
  } finally {
    busy.value = false
    fileList.value = []
  }
}

async function handleDatabaseReset(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将清空全部本地数据（外业账、分级账、发件箱、挂账）并重新播种演示数据。确认继续？',
      '重置本地数据',
      { type: 'warning', confirmButtonText: '清空并重建', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await resetDatabase()
  await refresh()
  notice.value = '本地两套账已重置为演示数据。'
  ElMessage.success(notice.value)
}

async function copySummary(): Promise<void> {
  const text = rows.value
    .map((row) => {
      const gradeText =
        row.gradeStatus === '已定级' && row.grade
          ? `白化指数 ${row.bleachIndex}（${row.grade}），白化占比 ${row.bleachedSharePct}%`
          : `定级状态「${row.gradeStatus}」，白化暂不能上报`
      return `${row.reefName}｜站位 ${row.siteNo}｜样带 ${row.beltNo}（${row.orientation}向 ${row.lengthM} m）：珊瑚覆盖率 ${row.coveragePct}%，${gradeText}，鱼类 ${row.fishTotal} 尾（${row.fishDensity} 尾/100m²）`
    })
    .join('\n')
  try {
    await navigator.clipboard.writeText(text)
    notice.value = '覆盖度结论已复制到剪贴板（白化以分级账为准）。'
    ElMessage.success(notice.value)
  } catch {
    notice.value = '当前浏览器不允许读取剪贴板，请手动选中表格内容复制。'
    ElMessage.warning(notice.value)
  }
}

function gotoGrading(): void {
  void router.push('/grading')
}

onMounted(() => {
  filter.keyword = typeof route.query.kw === 'string' ? route.query.kw : ''
  filter.reefIds = queryToArray(route.query.reef)
  filter.bleachLevels = queryToArray(route.query.level) as BleachLevel[]
  filter.onlyBleached = queryToBool(route.query.bleached)
  void refresh()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">外业覆盖度汇总（白化以分级账为准）</h2>
        <p class="gb-hint">
          按样带汇总珊瑚覆盖率与鱼类密度；白化指数、等级、礁区结论都来自分级组账，待复核 / 有分歧的样带不能对外上报。
          定级与对账请前往
          <el-button text type="primary" size="small" @click="gotoGrading">分级组工作台 →</el-button>
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="Refresh" @click="refresh">刷新</el-button>
        <el-button @click="copySummary">复制结论</el-button>
        <el-button type="primary" :icon="Download" :loading="busy" @click="handleExport">导出 JSON</el-button>
      </div>
    </div>

    <el-alert v-if="notice" type="success" :closable="false" show-icon :title="notice" />

    <div class="gb-stats-row">
      <StatBadge label="样带数" :value="totals.belts" suffix="条" icon="Files" />
      <StatBadge label="珊瑚覆盖记录" :value="totals.coralCount" suffix="条" tone="info" icon="Histogram" />
      <StatBadge label="覆盖长度合计" :value="totals.coverCmTotal" suffix="cm" tone="success" icon="Odometer" />
      <StatBadge label="平均覆盖率" :value="totals.avgCoveragePct" suffix="%" :percent="Math.min(100, totals.avgCoveragePct)" icon="PieChart" />
      <StatBadge label="已定级 / 待复核" :value="`${totals.graded} / ${totals.pending}`" tone="warning" icon="DocumentChecked" />
      <StatBadge label="有分歧" :value="totals.conflict" suffix="条" :tone="totals.conflict > 0 ? 'danger' : 'success'" icon="WarningFilled" />
      <StatBadge label="鱼类合计" :value="totals.fishTotal" suffix="尾" tone="info" icon="TrendCharts" />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'reefIds',
          label: '礁区',
          options: reefStore.reefs.map((reef) => ({ label: reef.name, value: reef.id }))
        },
        {
          key: 'bleachLevels',
          label: '白化等级',
          options: BLEACH_LEVELS.map((level) => ({ label: level, value: level }))
        }
      ]"
      :has-switch="true"
      switch-label="仅看存在白化的样带（分级账）"
      :switch-value="filter.onlyBleached"
      keyword-placeholder="搜索礁区 / 站位 / 样带 / 调查人"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>白化等级分布（分级账覆盖快照 cm）</h3>
        <span class="gb-hint">
          分级账已定级样带 {{ globalGraded.gradedBelts }} / {{ globalGraded.totalBelts }} ·
          总体指数 {{ globalGraded.index }}（{{ globalGraded.grade }}）· 存在白化样带 {{ totals.bleachedBelts }} 条
        </span>
      </div>
      <div class="gb-bars">
        <div v-for="level in BLEACH_LEVELS" :key="`dist-${level}`" class="gb-bar">
          <span>{{ level }}</span>
          <span class="gb-bar__track">
            <span
              class="gb-bar__fill"
              :style="{ background: BLEACH_COLOR[level], width: barPercent(distribution[level], distributionTotal) }"
            ></span>
          </span>
          <span class="gb-mono">{{ distribution[level] }} cm</span>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>按样带的覆盖度成果（{{ rows.length }} 条）</h3>
        <span class="gb-hint">覆盖按外业账、白化按分级账；白化指数降序</span>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        title="没有符合条件的样带"
        description="请先到礁区台账布设站位与样带并录入珊瑚覆盖；白化等级由分级组在工作台定级。"
        compact
      />

      <el-table v-else :data="rows" border stripe class="gb-table-compact">
        <el-table-column label="礁区 / 站位" min-width="180">
          <template #default="{ row }">
            <div>{{ row.reefName }}</div>
            <div class="gb-hint">站位 {{ row.siteNo }} · 样带 {{ row.beltNo }}（{{ row.orientation }}向）</div>
          </template>
        </el-table-column>
        <el-table-column label="定级状态" width="110">
          <template #default="{ row }">
            <GradeStatusTag :status="row.gradeStatus" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="样带长度" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.lengthM }} m</span>
          </template>
        </el-table-column>
        <el-table-column label="珊瑚覆盖" width="90" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coralCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="覆盖率（外业）" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coveragePct }}%</span>
            <div class="gb-hint gb-mono">{{ row.coverCmTotal }} cm</div>
          </template>
        </el-table-column>
        <el-table-column label="白化评定（分级账）" width="180">
          <template #default="{ row }">
            <BleachTag v-if="row.grade && row.gradeStatus === '已定级'" :level="row.grade" size="small" />
            <span v-else class="gb-hint">{{ row.gradeStatus }}</span>
            <div class="gb-hint gb-mono">指数 {{ row.bleachIndex }} · 占比 {{ row.bleachedSharePct }}%</div>
          </template>
        </el-table-column>
        <el-table-column label="白化等级分布 (cm)" min-width="220">
          <template #default="{ row }">
            <div class="page__mini-bars">
              <span
                v-for="level in BLEACH_LEVELS"
                :key="`${row.beltId}-${level}`"
                class="page__mini-bar"
                :style="{
                  background: BLEACH_COLOR[level],
                  width: barPercent(row.distribution[level], row.coverCmTotal),
                  opacity: row.distribution[level] > 0 ? 1 : 0.15
                }"
                :title="`${level}：${row.distribution[level]} cm`"
              ></span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="鱼类" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.fishTotal }} 尾</span>
            <div class="gb-hint gb-mono">{{ row.fishDensity }} 尾/100m²</div>
          </template>
        </el-table-column>
        <el-table-column label="无脊椎动物" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.invertebrateTotal }} 个</span>
          </template>
        </el-table-column>
        <el-table-column label="调查" min-width="150">
          <template #default="{ row }">
            <div class="gb-mono">{{ row.surveyDate }}</div>
            <div class="gb-hint">{{ row.observer || '未填写调查人' }}</div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>按礁区的白化评定（分级账口径）</h3>
        <span class="gb-hint">平均白化指数仅统计本礁区「已定级」样带；待复核 / 有分歧单列计数</span>
      </div>
      <el-table :data="reefSummaries" border stripe class="gb-table-compact">
        <el-table-column prop="reefName" label="礁区" min-width="160" />
        <el-table-column prop="protectStatus" label="保护区状态" width="120" />
        <el-table-column label="站位 / 样带" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.siteCount }} / {{ row.beltCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="已定级/待复核/分歧" width="180" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.statusCounts.已定级 }} / {{ row.statusCounts.待复核 }} / {{ row.statusCounts.有分歧 }}</span>
          </template>
        </el-table-column>
        <el-table-column label="覆盖长度" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coverCmTotal }} cm</span>
          </template>
        </el-table-column>
        <el-table-column label="平均白化指数" width="160">
          <template #default="{ row }">
            <BleachTag v-if="row.grade" :level="row.grade" size="small" />
            <span v-else class="gb-hint">未定级</span>
            <span class="gb-hint gb-mono"> {{ row.avgBleachIndex }}</span>
          </template>
        </el-table-column>
        <el-table-column label="鱼类计数" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.fishTotal }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>结构版本与两套账 JSON 导入导出</h3>
        <span class="gb-hint">
          导出含外业账 5 表 + 分级账 3 表（不含设备本地发件箱）· 最近备份
          {{ lastBackupAt ? new Date(lastBackupAt).toLocaleString('zh-CN') : '尚未备份' }}
        </span>
      </div>

      <el-form label-width="120px">
        <el-form-item label="导入模式">
          <el-radio-group v-model="overwriteOnImport">
            <el-radio :value="true">覆盖（先清空本地两套账与发件箱）</el-radio>
            <el-radio :value="false">追加（重新分配 id）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="选择备份文件">
          <el-upload
            v-model:file-list="fileList"
            :auto-upload="false"
            :limit="1"
            accept="application/json"
            :on-exceed="() => ElMessage.warning('一次只能选择一个文件')"
          >
            <el-button :icon="Upload">选择 JSON 文件</el-button>
            <template #tip>
              <div class="gb-hint">仅支持本应用导出的备份文件（app 字段为 gbcoralbelt，v2 旧备份可兼容导入）</div>
            </template>
          </el-upload>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Upload" :loading="busy" @click="handleImport">开始导入</el-button>
          <el-button :icon="Download" @click="handleExport">导出当前数据</el-button>
          <el-button type="danger" plain @click="handleDatabaseReset">清空并重建演示数据</el-button>
        </el-form-item>
      </el-form>

      <el-descriptions :column="3" border size="small">
        <el-descriptions-item label="本地库名">{{ DB_NAME }}</el-descriptions-item>
        <el-descriptions-item label="结构版本">v{{ DB_VERSION }}（浏览器记录 v{{ stampedVersion }}）</el-descriptions-item>
        <el-descriptions-item label="外业账 礁区/站位">{{ counts.reefs }} / {{ counts.sites }}</el-descriptions-item>
        <el-descriptions-item label="外业账 样带/覆盖/计数">{{ counts.belts }} / {{ counts.corals }} / {{ counts.fishes }}</el-descriptions-item>
        <el-descriptions-item label="分级账 等级/定级/结论">{{ counts.assessments }} / {{ counts.beltGrades }} / {{ counts.reefConclusions }}</el-descriptions-item>
        <el-descriptions-item label="最近备份时间">
          {{ lastBackupAt ? new Date(lastBackupAt).toLocaleString('zh-CN') : '尚未备份' }}
        </el-descriptions-item>
      </el-descriptions>
      <p class="gb-hint">
        数据仅保存在当前浏览器 IndexedDB 中；外业账与分级账分开存，换浏览器或清空站点数据后请通过 JSON 备份迁移。
      </p>
    </el-card>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__mini-bars {
  display: flex;
  gap: 2px;
  height: 12px;
  border-radius: 999px;
  overflow: hidden;
  background: #eef7f6;
}

.page__mini-bar {
  display: block;
  height: 100%;
}
</style>
