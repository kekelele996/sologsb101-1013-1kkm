<script setup lang="ts">
/**
 * 模块 4：/belts/:id/corals 底质与珊瑚分类覆盖（外业队账）
 * 外业队只按属名与形态录入覆盖长度；白化等级不归本页——一律读分级组账（只读回显）。
 * 补记 / 覆盖导入会自动进断网发件箱；若该样带已定级，对账后自动转「待复核」，分级组原等级照旧。
 * 深链访问时样带不存在给出友好空态。复用 <BleachTag>、<StatBadge>。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, DocumentCopy, Edit, Plus } from '@element-plus/icons-vue'
import BleachTag from '@/components/common/BleachTag.vue'
import GradeStatusTag from '@/components/common/GradeStatusTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useGradingStore } from '@/stores/gradingStore'
import { useSyncStore } from '@/stores/syncStore'
import { COMMON_GENERA, CORAL_FORMS, parseCoralPaste } from '@/types/coralRecord'
import type { CoralForm, CoralRecord } from '@/types/coralRecord'
import { BLEACH_LEVELS, type BleachLevel } from '@/types/coralRecord'
import { BLEACH_COLOR, coralCoveragePct, groupByForm, groupByGenus } from '@/utils/bleach'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()
const gradingStore = useGradingStore()
const syncStore = useSyncStore()

const beltId = computed(() => String(route.params.id ?? ''))
const belt = computed(() => beltStore.beltById(beltId.value))
const site = computed(() => (belt.value ? reefStore.siteById(belt.value.siteId) : null))
const reef = computed(() => (site.value ? reefStore.reefById(site.value.reefId) : null))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const pasteVisible = ref(false)
const pasteText = ref('')
const pasteErrors = ref<string[]>([])
const pasteIgnored = ref(0)
const form = reactive({
  genus: '',
  form: '枝状' as CoralForm,
  coverCm: 100,
  remark: ''
})

const records = computed(() => surveyStore.coralsOfBelt(beltId.value))
const gradeRow = computed(() => gradingStore.gradeOfBelt(beltId.value))
/** 分级组逐条等级（只读），按珊瑚记录 id 取 */
const levelByCoral = computed<Map<string, BleachLevel>>(
  () => new Map(gradingStore.assessmentsOfBelt(beltId.value).map((row) => [row.id, row.bleachLevel]))
)

/** 按属名分组汇总（覆盖长度） */
const genusGroups = computed(() =>
  groupByGenus(records.value).map((group) => ({
    ...group,
    count: records.value.filter((record) => record.genus === group.genus).length
  }))
)

/** 按形态分组汇总 */
const formGroups = computed(() => groupByForm(records.value))

const stats = computed(() => {
  const list = records.value
  const coverCmTotal = list.reduce((sum, record) => sum + record.coverCm, 0)
  const graded = gradingStore.gradedBeltStats(belt.value, beltId.value)
  return {
    coralCount: list.length,
    coverCmTotal,
    coveragePct: belt.value ? coralCoveragePct(coverCmTotal, belt.value.lengthM) : 0,
    maxCoverCm: list.length ? Math.max(...list.map((record) => record.coverCm)) : 0,
    graded
  }
})

/** 分级账白化等级 → 累计覆盖长度（只读，取分级快照） */
const distribution = computed<Record<BleachLevel, number>>(() => gradingStore.gradedDistribution(beltId.value))

/** 进度条宽度（%），总量为 0 时返回 0% */
function barPercent(value: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0%'
  return `${Math.min(100, (value / total) * 100).toFixed(1)}%`
}

function openCreate(): void {
  editingId.value = null
  form.genus = ''
  form.form = '枝状'
  form.coverCm = 100
  form.remark = ''
  dialogVisible.value = true
}

function openEdit(record: CoralRecord): void {
  editingId.value = record.id
  form.genus = record.genus
  form.form = record.form
  form.coverCm = record.coverCm
  form.remark = record.remark
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.genus.trim()) {
    ElMessage.warning('请填写属名')
    return
  }
  if (!Number.isFinite(form.coverCm) || form.coverCm < 0) {
    ElMessage.warning('覆盖长度应为非负数字（cm）')
    return
  }
  if (belt.value && form.coverCm > belt.value.lengthM * 100) {
    ElMessage.warning(`覆盖长度不应超过样带长度（${belt.value.lengthM * 100} cm）`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      genus: form.genus.trim(),
      form: form.form,
      coverCm: form.coverCm,
      remark: form.remark.trim()
    }
    const gradedBefore = gradeRow.value?.status === '已定级'
    if (editingId.value) {
      await surveyStore.updateCoral(editingId.value, payload)
      ElMessage.success(gradedBefore ? '覆盖已补记（外业账）；该样带已定级，网络对账后将转待复核，分级组原等级不变' : '珊瑚覆盖已更新（外业账）')
    } else {
      await surveyStore.createCoral(beltId.value, payload)
      ElMessage.success(gradedBefore ? '覆盖已补记（外业账）；该样带已定级，网络对账后将转待复核' : '珊瑚覆盖已新增，覆盖率已重算')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeRecord(record: CoralRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除「${record.genus}（${record.form}）」覆盖 ${record.coverCm} cm 的外业记录？分级组已有的定级不会被删，对账时按待复核处理。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await surveyStore.removeCoral(record.id)
  ElMessage.success('珊瑚覆盖记录已从外业账删除')
}

function openPaste(): void {
  pasteText.value = ''
  pasteErrors.value = []
  pasteIgnored.value = 0
  pasteVisible.value = true
}

function previewPaste(): void {
  const parsed = parseCoralPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  pasteIgnored.value = parsed.ignoredLevels
  if (parsed.rows.length === 0 && parsed.errors.length === 0) {
    ElMessage.warning('请先粘贴内容，每行格式「属名,形态,覆盖长度」')
  }
}

async function importPaste(): Promise<void> {
  const parsed = parseCoralPaste(pasteText.value)
  pasteErrors.value = parsed.errors
  pasteIgnored.value = parsed.ignoredLevels
  if (parsed.rows.length === 0) {
    ElMessage.warning('没有可导入的有效行')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将用 ${parsed.rows.length} 行覆盖数据替换该样带现有 ${records.value.length} 条外业记录？白化等级在分级组那边，不受影响。`,
      '批量导入确认',
      { type: 'warning', confirmButtonText: '覆盖导入', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const count = await surveyStore.importCoralRows(beltId.value, parsed.rows)
  pasteVisible.value = false
  ElMessage.success(
    `已导入 ${count} 条覆盖记录（外业账）${parsed.ignoredLevels > 0 ? `；忽略 ${parsed.ignoredLevels} 个粘贴的白化等级（等级在分级工作台定）` : ''}`
  )
}

function gotoFishes(): void {
  void router.push(`/belts/${beltId.value}/fishes`)
}

function gotoGrading(): void {
  void router.push('/grading')
}

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
  if (belt.value) beltStore.selectBelt(belt.value.id)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!beltStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!belt"
      entity-label="样带"
      :missing-id="beltId"
      fallback-path="/reefs"
      fallback-text="返回礁区台账"
      :candidates="
        beltStore.belts.slice(0, 3).map((item) => ({
          id: item.id,
          label: `样带 ${item.no} 的珊瑚覆盖`,
          path: `/belts/${item.id}/corals`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/reefs' }">礁区台账</el-breadcrumb-item>
            <el-breadcrumb-item v-if="reef" :to="{ path: `/reefs/${reef.id}/sites` }">{{ reef.name }} 站位</el-breadcrumb-item>
            <el-breadcrumb-item v-if="site" :to="{ path: `/sites/${site.id}/belts` }">站位 {{ site.no }} 样带</el-breadcrumb-item>
            <el-breadcrumb-item>珊瑚分类覆盖（外业）</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            样带 {{ belt.no }} · 底质与珊瑚分类覆盖
            <el-tag size="small" effect="plain">{{ belt.orientation }}向</el-tag>
            <el-tag size="small" type="info" effect="plain">长 {{ belt.lengthM }} m</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ belt.surveyDate }}</el-tag>
            <GradeStatusTag v-if="gradeRow" :status="gradeRow.status" size="small" />
          </h2>
          <p class="gb-hint">
            外业队只录属名、形态与覆盖长度；白化等级由分级组在工作台定，本页只读展示。覆盖率 = 覆盖长度合计 / 样带长度。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="DocumentCopy" @click="openPaste">批量粘贴</el-button>
          <el-button @click="gotoFishes">鱼类计数 →</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增珊瑚覆盖</el-button>
        </div>
      </div>

      <el-alert
        v-if="gradeRow?.status === '待复核'"
        type="warning"
        show-icon
        :closable="false"
        title="该样带已定过级，外业补记后覆盖依据已变更：样带已转「待复核」，分级组原等级保留，等分级组在工作台复核。"
        class="page__alert"
      />
      <el-alert
        v-else-if="gradeRow?.status === '有分歧'"
        type="error"
        show-icon
        :closable="false"
        title="该样带外业账与分级账存在对账分歧，等级与礁区结论暂不能上报，需分级组人工裁定。"
        class="page__alert"
      />
      <el-alert
        v-else-if="!syncStore.online"
        type="info"
        show-icon
        :closable="false"
        title="现场断网中：补记照常保存到本机并发件箱暂存，网络恢复后自动按样带编号对账。"
        class="page__alert"
      />

      <div class="gb-stats-row">
        <StatBadge label="珊瑚覆盖记录" :value="stats.coralCount" suffix="条" icon="Histogram" />
        <StatBadge label="覆盖长度合计" :value="stats.coverCmTotal" suffix="cm" tone="info" icon="Odometer" />
        <StatBadge label="珊瑚覆盖率" :value="stats.coveragePct" suffix="%" :percent="Math.min(100, stats.coveragePct)" tone="success" icon="PieChart" />
        <StatBadge
          label="分级账白化指数"
          :value="gradeRow?.bleachIndex ?? '—'"
          suffix="/ 4"
          tone="info"
          icon="DataLine"
        />
        <StatBadge
          :label="gradeRow?.grade ? '分级组定级' : '分级组定级'"
          :value="gradeRow?.grade ?? '未定级'"
          :tone="gradeRow?.status === '待复核' ? 'warning' : 'success'"
          icon="TrendCharts"
        />
      </div>

      <el-card v-if="records.length > 0" shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>汇总视图（外业覆盖）</h3>
          <el-button size="small" text type="primary" @click="gotoGrading">白化等级去分级组工作台定 →</el-button>
        </div>
        <div class="page__grid">
          <div>
            <h4 class="page__sub">按属名分组（覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="group in genusGroups" :key="group.genus" class="gb-bar">
                <span>{{ group.genus }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: '#0b5d5a', width: barPercent(group.coverCm, stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">{{ group.coverCm }} cm · {{ group.count }} 条</span>
              </div>
            </div>
          </div>
          <div>
            <h4 class="page__sub">按形态分组（覆盖长度 cm）</h4>
            <div class="gb-bars">
              <div v-for="group in formGroups" :key="group.form" class="gb-bar">
                <span>{{ group.form }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: '#3f9ec4', width: barPercent(group.coverCm, stats.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">{{ group.coverCm }} cm</span>
              </div>
            </div>
          </div>
          <div>
            <h4 class="page__sub">白化等级分布（分级账快照，只读）</h4>
            <div class="gb-bars">
              <div v-for="level in BLEACH_LEVELS" :key="`bar-${level}`" class="gb-bar">
                <span>{{ level }}</span>
                <span class="gb-bar__track">
                  <span
                    class="gb-bar__fill"
                    :style="{ background: BLEACH_COLOR[level], width: barPercent(distribution[level], stats.graded.coverCmTotal) }"
                  ></span>
                </span>
                <span class="gb-mono">{{ distribution[level] }} cm</span>
              </div>
            </div>
            <p v-if="!gradeRow || gradeRow.status === '未定级'" class="gb-hint">分级组尚未定级，分布为空，白化数字不能上报。</p>
          </div>
        </div>
      </el-card>

      <EmptyPanel
        v-if="records.length === 0"
        title="该样带还没有珊瑚覆盖记录"
        description="外业按属名与形态逐条录入覆盖长度即可（白化等级不用填）；也可以批量粘贴导入整段摸底数据。"
        action-text="新增珊瑚覆盖"
        secondary-text="批量粘贴导入"
        @action="openCreate"
        @secondary="openPaste"
      />

      <el-table v-else :data="records" border stripe class="gb-table-compact">
        <el-table-column prop="genus" label="属名" min-width="140" />
        <el-table-column prop="form" label="形态" width="100" />
        <el-table-column label="覆盖长度 (cm)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coverCm }}</span>
            <div class="gb-hint gb-mono">
              占样带 {{ belt.lengthM > 0 ? ((row.coverCm / (belt.lengthM * 100)) * 100).toFixed(1) : '0.0' }}%
            </div>
          </template>
        </el-table-column>
        <el-table-column label="白化等级（分级账·只读）" width="180">
          <template #default="{ row }">
            <BleachTag v-if="levelByCoral.has(row.id)" :level="levelByCoral.get(row.id) ?? '无'" size="small" :plain="true" />
            <span v-else class="gb-hint">{{ gradeRow?.status === '待复核' ? '待复核' : '未定级' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑覆盖</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRecord(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无珊瑚覆盖记录" description="点击右上角「新增珊瑚覆盖」开始录入。" compact />
        </template>
      </el-table>

      <p v-if="records.length > 0" class="gb-hint">
        最大单条覆盖长度 {{ stats.maxCoverCm }} cm；外业只改覆盖，等级一律以分级组工作台为准。
      </p>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑珊瑚覆盖（外业）' : '新增珊瑚覆盖（外业）'" width="540px" :close-on-click-modal="false">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="外业账不录白化等级；等级由分级组定级。若该样带已定级，保存后对账会转「待复核」。"
        class="page__dialog-alert"
      />
      <el-form label-width="110px">
        <el-form-item label="属名" required>
          <el-input v-model="form.genus" list="genus-options" placeholder="如：鹿角珊瑚属" maxlength="30" />
          <datalist id="genus-options">
            <option v-for="genus in COMMON_GENERA" :key="genus" :value="genus"></option>
          </datalist>
        </el-form-item>
        <el-form-item label="形态" required>
          <el-radio-group v-model="form.form">
            <el-radio-button v-for="item in CORAL_FORMS" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="覆盖长度" required>
          <el-input-number v-model="form.coverCm" :min="0" :max="belt ? belt.lengthM * 100 : 10000" :step="10" controls-position="right" />
          <span class="page__unit">cm（样带全长 {{ belt ? belt.lengthM * 100 : 0 }} cm）</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" placeholder="如：局部褪色 / 台风扰动后白化（仅记录现场情况）" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新增覆盖' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pasteVisible" title="批量粘贴导入珊瑚覆盖" width="620px">
      <p class="gb-hint">
        每行一条，格式「属名,形态,覆盖长度(cm)」，逗号 / 制表符 / 分号均可。白化等级不用填（填了也忽略）。示例：<br />
        <span class="gb-mono">鹿角珊瑚属,枝状,860</span><br />
        <span class="gb-mono">蔷薇珊瑚属;叶状;720</span><br />
        <span class="gb-mono">滨珊瑚属,块状,1120</span>
      </p>
      <el-input v-model="pasteText" type="textarea" :rows="8" placeholder="鹿角珊瑚属,枝状,860" />
      <el-alert
        v-if="pasteIgnored > 0"
        type="success"
        :closable="false"
        show-icon
        :title="`已识别并忽略 ${pasteIgnored} 个粘贴的白化等级——等级在分级组工作台定。`"
        class="page__dialog-alert"
      />
      <div v-if="pasteErrors.length > 0" class="page__errors">
        <el-alert v-for="(error, index) in pasteErrors" :key="index" type="warning" :title="error" :closable="false" show-icon />
      </div>
      <template #footer>
        <el-button @click="pasteVisible = false">取消</el-button>
        <el-button @click="previewPaste">解析预览</el-button>
        <el-button type="primary" @click="importPaste">覆盖导入</el-button>
      </template>
    </el-dialog>
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
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__alert {
  margin: 0;
}

.page__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}

.page__sub {
  margin: 0 0 8px;
  font-size: 13px;
  color: #4c6663;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #7c9995;
}

.page__dialog-alert {
  margin-bottom: 12px;
}

.page__errors {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  max-height: 160px;
  overflow: auto;
}
</style>
