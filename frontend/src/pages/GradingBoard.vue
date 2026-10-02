<script setup lang="ts">
/**
 * 模块 7：/grading 分级组工作台
 * 分级组独占的一页：
 * 1. 对账中心：断网发件箱、网络开关（现场断网模拟）、同步中断模拟、手动重试 / 重新对账
 * 2. 待裁定：对不上的样带（待复核 / 有分歧 / 编号重复）人工裁定
 * 3. 样带定级：逐条珊瑚覆盖定白化等级，拍快照进分级账（外业之后再改只转待复核，不覆盖等级）
 * 4. 礁区结论：撰写 / 修改上报口径的礁区结论（外业不可改）
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  CircleCheck,
  Connection,
  DocumentChecked,
  Refresh,
  RefreshRight,
  Warning
} from '@element-plus/icons-vue'
import BleachTag from '@/components/common/BleachTag.vue'
import GradeStatusTag from '@/components/common/GradeStatusTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useBeltStore } from '@/stores/beltStore'
import { useReefStore } from '@/stores/reefStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useGradingStore } from '@/stores/gradingStore'
import { useSyncStore } from '@/stores/syncStore'
import { BLEACH_LEVELS } from '@/types/coralRecord'
import type { BleachLevel } from '@/types/coralRecord'
import type { Belt } from '@/types/belt'
import { ISSUE_KIND_META } from '@/types/grading'
import type { GradeStatus, IssueResolution } from '@/types/grading'
import { bleachGrade, bleachIndex } from '@/utils/bleach'
import { initDatabase } from '@/utils/db'

const beltStore = useBeltStore()
const reefStore = useReefStore()
const surveyStore = useSurveyStore()
const gradingStore = useGradingStore()
const syncStore = useSyncStore()

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
})

/* ------------------------------ 样带行拼装 ------------------------------ */

interface GradingRow {
  belt: Belt
  reefName: string
  siteNo: string
  fieldCorals: ReturnType<typeof surveyStore.coralsOfBelt>
  status: GradeStatus
  grade: BleachLevel | null
  index: number | null
  fieldHashChanged: boolean
  coverCmTotal: number
  gradedBy: string
  note: string
}

const rows = computed(() =>
  beltStore.belts
    .map((belt) => {
      const site = reefStore.siteById(belt.siteId)
      const reef = site ? reefStore.reefById(site.reefId) : null
      const gradeRow = gradingStore.gradeOfBelt(belt.id)
      const snapshot = gradingStore.assessmentsOfBelt(belt.id)
      const fieldCorals = surveyStore.coralsOfBelt(belt.id)
      return {
        belt,
        reefName: reef?.name ?? '未知礁区',
        siteNo: site?.no ?? '—',
        fieldCorals,
        status: gradeRow?.status ?? '未定级',
        grade: gradeRow?.grade ?? null,
        index: gradeRow?.bleachIndex ?? (snapshot.length > 0 ? bleachIndex(snapshot) : null),
        fieldHashChanged: gradeRow ? gradeRow.status === '待复核' || gradeRow.status === '有分歧' : false,
        coverCmTotal: fieldCorals.reduce((sum, coral) => sum + coral.coverCm, 0),
        gradedBy: gradeRow?.gradedBy ?? '',
        note: gradeRow?.note ?? ''
      } satisfies GradingRow
    })
    .sort((a, b) => {
      const order = { 有分歧: 0, 待复核: 1, 未定级: 2, 已定级: 3 } as const
      const diff = order[a.status] - order[b.status]
      if (diff !== 0) return diff
      return a.belt.no.localeCompare(b.belt.no, 'zh-Hans-CN')
    })
)

const stats = computed(() => ({
  total: rows.value.length,
  graded: rows.value.filter((row) => row.status === '已定级').length,
  pending: rows.value.filter((row) => row.status === '待复核').length,
  conflict: rows.value.filter((row) => row.status === '有分歧').length,
  ungraded: rows.value.filter((row) => row.status === '未定级').length,
  outbox: syncStore.pendingCount,
  issues: syncStore.openIssues.length
}))

/* ------------------------------ 定级弹窗 ------------------------------ */

const gradingVisible = ref(false)
const gradingBelt = ref<Belt | null>(null)
const submittingGrade = ref(false)
const levelForm = reactive<{
  levels: Record<string, BleachLevel>
  gradedBy: string
  note: string
}>({
  levels: {},
  gradedBy: '分级组·沈定级',
  note: ''
})

const gradingCorals = computed(() =>
  gradingBelt.value ? surveyStore.coralsOfBelt(gradingBelt.value.id) : []
)

const gradingSnapshot = computed(() =>
  gradingBelt.value ? gradingStore.assessmentsOfBelt(gradingBelt.value.id) : []
)

const previewIndex = computed(() =>
  bleachIndex(
    gradingCorals.value.map((coral) => ({
      coverCm: coral.coverCm,
      bleachLevel: levelForm.levels[coral.id] ?? '无'
    }))
  )
)

function openGrading(belt: Belt): void {
  gradingBelt.value = belt
  const snapshot = new Map(gradingStore.assessmentsOfBelt(belt.id).map((row) => [row.id, row.bleachLevel]))
  levelForm.levels = {}
  surveyStore.coralsOfBelt(belt.id).forEach((coral) => {
    levelForm.levels[coral.id] = snapshot.get(coral.id) ?? '无'
  })
  const gradeRow = gradingStore.gradeOfBelt(belt.id)
  levelForm.gradedBy = gradeRow?.gradedBy || '分级组·沈定级'
  levelForm.note = gradeRow?.status === '待复核' ? '外业补记后复核重定' : ''
  gradingVisible.value = true
}

async function submitGrading(): Promise<void> {
  if (!gradingBelt.value) return
  if (!levelForm.gradedBy.trim()) {
    ElMessage.warning('请填写定级人')
    return
  }
  submittingGrade.value = true
  try {
    await gradingStore.gradeBelt(gradingBelt.value, surveyStore.coralsOfBelt(gradingBelt.value.id), {
      levels: { ...levelForm.levels },
      gradedBy: levelForm.gradedBy.trim(),
      note: levelForm.note.trim()
    })
    ElMessage.success(`样带 ${gradingBelt.value.no} 已定级（${bleachGrade(previewIndex.value)}），等级入分级账`)
    gradingVisible.value = false
  } finally {
    submittingGrade.value = false
  }
}

async function submitKeepOld(belt: Belt): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `维持样带 ${belt.no} 原来的定级不变，仅把对账基线刷新到外业最新覆盖？`,
      '维持原等级确认',
      { type: 'warning', confirmButtonText: '维持原等级', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await gradingStore.keepOldGrade(belt, surveyStore.coralsOfBelt(belt.id), '分级组·沈定级')
  ElMessage.success('已维持原等级并刷新对账基线，样带恢复已定级')
}

/* ------------------------------ 对账中心 ------------------------------ */

async function handleFlush(): Promise<void> {
  const result = await syncStore.flush()
  if (result.ran) {
    ElMessage.success(
      `对账完成：发送 ${result.synced} 条，新转待复核 ${result.pendingReview} 条，分歧 ${result.conflicts} 条`
    )
  } else if (result.reason === 'offline') {
    ElMessage.info('现场断网中，改动已记进发件箱，网络恢复后自动对账')
  } else if (result.reason === 'interrupted') {
    ElMessage.error('同步中断：发件箱留在外业待重试，分级组那份账未改动')
  } else if (result.reason === 'empty') {
    ElMessage.success('发件箱为空，两边账已是一致的')
  }
}

async function handleReconcile(): Promise<void> {
  const result = await syncStore.reconcileOnly()
  if (result.ran) {
    ElMessage.success(`已按样带重新对账：待复核 ${result.pendingReview} 条，分歧 ${result.conflicts} 条`)
  } else {
    ElMessage.info('当前断网，无法对账')
  }
}

/* ------------------------------ 异常裁定 ------------------------------ */

async function resolveIssue(
  issueId: string,
  resolution: Extract<IssueResolution, 'drop-grading' | 'keep-grading' | 'recheck'>
): Promise<void> {
  const issue = syncStore.openIssues.find((item) => item.id === issueId)
  if (!issue) return
  const operator = '分级组·沈定级'

  if (issue.kind === 'coverage-changed' && issue.beltId) {
    const belt = beltStore.beltById(issue.beltId)
    if (!belt) return
    if (resolution === 'drop-grading') {
      openGrading(belt)
      return
    }
    if (resolution === 'keep-grading') {
      await gradingStore.keepOldGrade(belt, surveyStore.coralsOfBelt(belt.id), operator)
      ElMessage.success('已维持原等级，样带恢复已定级')
      return
    }
  }

  if (issue.kind === 'belt-deleted' && issue.beltId) {
    if (resolution === 'recheck') {
      await gradingStore.resolveDuplicateNo(issue.beltId, operator)
      ElMessage.success('已确认编号修正，下一轮对账按新编号核对')
      return
    }
    await gradingStore.resolveDeletedBelt(
      issue.beltId,
      resolution as 'drop-grading' | 'keep-grading',
      operator
    )
    ElMessage.success(resolution === 'drop-grading' ? '已连带删除该样带的分级账' : '分级账已留底备查')
    return
  }

  if (issue.kind === 'reef-deleted' && issue.reefId) {
    await gradingStore.resolveDeletedReef(
      issue.reefId,
      resolution as 'drop-grading' | 'keep-grading',
      operator
    )
    ElMessage.success(resolution === 'drop-grading' ? '已删除该礁区结论' : '礁区结论已留底备查')
    return
  }

  if (issue.kind === 'duplicate-no' && issue.beltId) {
    await gradingStore.resolveDuplicateNo(issue.beltId, operator)
    ElMessage.success('已确认，请外业修正样带编号后再重新对账')
  }
}

/* ------------------------------ 礁区结论 ------------------------------ */

const conclusionVisible = ref(false)
const conclusionForm = reactive({ reefId: '', reefName: '', conclusion: '', gradedBy: '分级组·沈定级' })
const submittingConclusion = ref(false)

function openConclusion(reefId: string): void {
  const reef = reefStore.reefById(reefId)
  const existing = gradingStore.conclusionOfReef(reefId)
  conclusionForm.reefId = reefId
  conclusionForm.reefName = reef?.name ?? ''
  conclusionForm.conclusion = existing?.conclusion ?? ''
  conclusionForm.gradedBy = existing?.gradedBy || '分级组·沈定级'
  conclusionVisible.value = true
}

async function submitConclusion(): Promise<void> {
  if (!conclusionForm.reefId) return
  if (!conclusionForm.conclusion.trim()) {
    ElMessage.warning('请填写礁区结论')
    return
  }
  submittingConclusion.value = true
  try {
    await gradingStore.saveReefConclusion(
      conclusionForm.reefId,
      conclusionForm.reefName,
      conclusionForm.conclusion.trim(),
      conclusionForm.gradedBy.trim() || '分级组·沈定级'
    )
    ElMessage.success('礁区结论已存入分级账，外业侧上报口径同步以此为准')
    conclusionVisible.value = false
  } finally {
    submittingConclusion.value = false
  }
}

const lastSyncText = computed(() =>
  syncStore.lastSyncAt ? new Date(syncStore.lastSyncAt).toLocaleString('zh-CN') : '尚未成功对账'
)
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">分级组工作台 · 白化定级与礁区结论</h2>
        <p class="gb-hint">
          本页写分级组自己那份账（白化等级 / 样带定级 / 礁区结论），外业补记不会覆盖它；
          网络恢复后按样带编号与外业账对账，对不上的挂起等人定。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="RefreshRight" @click="handleReconcile">按样带重新对账</el-button>
        <el-button type="primary" :icon="Connection" :loading="syncStore.syncing" @click="handleFlush">
          发送发件箱并对账
        </el-button>
      </div>
    </div>

    <!-- 对账中心 -->
    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>对账中心（断网发件箱）</h3>
        <div class="sync-bar">
          <span class="gb-hint">现场网络：</span>
          <el-switch
            :model-value="syncStore.online"
            active-text="在线"
            inactive-text="断网"
            inline-prompt
            @change="(value: boolean | string | number) => syncStore.setOnline(Boolean(value))"
          />
          <el-divider direction="vertical" />
          <span class="gb-hint">演示：</span>
          <el-tooltip content="打开后下一次对账必失败：发件箱留外业重试，分级账一个字节不动" placement="top">
            <el-checkbox :model-value="syncStore.failNextFlush" @change="(value: boolean | string | number) => syncStore.setFailNextFlush(Boolean(value))">
              模拟下次同步中断
            </el-checkbox>
          </el-tooltip>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="待发送发件箱" :value="stats.outbox" suffix="条" tone="info" icon="Promotion" />
        <StatBadge label="待人工裁定" :value="stats.issues" suffix="条" :tone="stats.issues > 0 ? 'warning' : 'success'" icon="Warning" />
        <StatBadge label="待复核样带" :value="stats.pending" suffix="条" tone="warning" icon="Refresh" />
        <StatBadge label="有分歧样带" :value="stats.conflict" suffix="条" :tone="stats.conflict > 0 ? 'danger' : 'success'" icon="WarningFilled" />
        <StatBadge label="上次成功对账" :value="lastSyncText" icon="CircleCheck" />
      </div>

      <el-alert
        v-if="!syncStore.online"
        type="info"
        :closable="false"
        show-icon
        title="现场断网中：外业记账照常进行，所有改动已进本地发件箱；网络恢复（拨回在线）后自动按样带编号对账。"
      />
      <el-alert
        v-else-if="syncStore.lastSyncError"
        type="error"
        :closable="false"
        show-icon
        :title="`上次同步中断：${syncStore.lastSyncError}（已留发件箱，可点「发送发件箱并对账」重试）`"
      />
      <el-alert
        v-else
        type="success"
        :closable="false"
        show-icon
        :title="`在线，分级组账与外业账对账口径一致；最近成功对账：${lastSyncText}`"
      />

      <el-table v-if="syncStore.outbox.length > 0" :data="syncStore.outbox" border stripe size="small" class="sync-table">
        <el-table-column prop="entity" label="实体" width="90" />
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.op === 'delete' ? 'danger' : 'info'">{{ row.op === 'delete' ? '删除' : '新增/修改' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="关联样带" min-width="180">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.beltId ? beltStore.beltById(row.beltId)?.no ?? row.beltId : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="重试次数" width="90" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.attempts }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" min-width="200">
          <template #default="{ row }">
            <el-tag v-if="row.lastError" size="small" type="danger">同步中断 · 留外业重试</el-tag>
            <el-tag v-else size="small" type="info">{{ syncStore.online ? '等待对账' : '断网暂存' }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 待人工裁定 -->
    <el-card v-if="syncStore.openIssues.length > 0" shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>待人工裁定（{{ syncStore.openIssues.length }}）</h3>
        <span class="gb-hint">两边账对不上的都在这里，定过级的等级不会被自动改掉</span>
      </div>
      <el-table :data="syncStore.openIssues" border stripe class="gb-table-compact">
        <el-table-column label="类型" width="140">
          <template #default="{ row }">
            <el-tag :type="ISSUE_KIND_META[row.kind as keyof typeof ISSUE_KIND_META].type" size="small">
              {{ ISSUE_KIND_META[row.kind as keyof typeof ISSUE_KIND_META].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="事项" min-width="220" />
        <el-table-column prop="detail" label="对账情况" min-width="320" show-overflow-tooltip />
        <el-table-column label="人工裁定" width="320" fixed="right">
          <template #default="{ row }">
            <template v-if="row.kind === 'coverage-changed'">
              <el-button size="small" type="primary" @click="resolveIssue(row.id, 'drop-grading')">按新覆盖重新定级</el-button>
              <el-button size="small" @click="resolveIssue(row.id, 'keep-grading')">维持原等级</el-button>
            </template>
            <template v-else-if="row.kind === 'belt-deleted'">
              <el-button size="small" type="danger" plain @click="resolveIssue(row.id, 'drop-grading')">删除分级账</el-button>
              <el-button size="small" @click="resolveIssue(row.id, 'keep-grading')">留底备查</el-button>
            </template>
            <template v-else-if="row.kind === 'reef-deleted'">
              <el-button size="small" type="danger" plain @click="resolveIssue(row.id, 'drop-grading')">删除结论</el-button>
              <el-button size="small" @click="resolveIssue(row.id, 'keep-grading')">留底备查</el-button>
            </template>
            <template v-else>
              <el-button size="small" type="primary" @click="resolveIssue(row.id, 'recheck')">已改编号，重新对账</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 样带定级 -->
    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>样带白化定级（{{ rows.length }}）</h3>
        <span class="gb-hint">按「有分歧 → 待复核 → 未定级 → 已定级」排序</span>
      </div>

      <EmptyPanel
        v-if="rows.length === 0"
        title="还没有样带"
        description="外业队布设样带并录入珊瑚覆盖后，这里会出现待定级样带。"
        compact
      />

      <el-table v-else :data="rows" border stripe class="gb-table-compact">
        <el-table-column label="礁区 / 站位 / 样带" min-width="200">
          <template #default="{ row }">
            <div>{{ row.reefName }}</div>
            <div class="gb-hint">站位 {{ row.siteNo }} · 样带 {{ row.belt.no }}（{{ row.belt.orientation }}向 {{ row.belt.lengthM }} m）</div>
          </template>
        </el-table-column>
        <el-table-column label="定级状态" width="120">
          <template #default="{ row }">
            <GradeStatusTag :status="row.status" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="分级账等级" width="150">
          <template #default="{ row }">
            <BleachTag v-if="row.grade" :level="row.grade" size="small" />
            <span v-else class="gb-hint">未定级</span>
            <div v-if="row.index !== null" class="gb-hint gb-mono">指数 {{ row.index }}</div>
          </template>
        </el-table-column>
        <el-table-column label="外业覆盖（只读）" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coverCmTotal }} cm</span>
            <div class="gb-hint">{{ row.fieldCorals.length }} 条记录</div>
          </template>
        </el-table-column>
        <el-table-column label="定级人 / 备注" min-width="180">
          <template #default="{ row }">
            <div>{{ row.gradedBy || '—' }}</div>
            <div class="gb-hint">{{ row.note || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="DocumentChecked" @click="openGrading(row.belt)">
              {{ row.status === '已定级' ? '查看 / 改级' : '定级 / 复核' }}
            </el-button>
            <el-button v-if="row.status === '待复核'" size="small" :icon="CircleCheck" @click="submitKeepOld(row.belt)">
              维持原级
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 礁区结论 -->
    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>礁区结论（上报口径）</h3>
        <span class="gb-hint">结论归分级组撰写，外业上报的礁区情况以此为准</span>
      </div>
      <el-table :data="reefStore.reefs" border stripe class="gb-table-compact">
        <el-table-column prop="name" label="礁区" min-width="160" />
        <el-table-column prop="protectStatus" label="保护区状态" width="110" />
        <el-table-column label="定级结论" min-width="360">
          <template #default="{ row }">
            <template v-if="gradingStore.conclusionOfReef(row.id)">
              <div>{{ gradingStore.conclusionOfReef(row.id)?.conclusion }}</div>
              <div class="gb-hint">
                {{ gradingStore.conclusionOfReef(row.id)?.gradedBy }} ·
                {{ gradingStore.conclusionOfReef(row.id)?.gradedAt
                  ? new Date(gradingStore.conclusionOfReef(row.id)!.gradedAt).toLocaleString('zh-CN')
                  : '' }}
              </div>
            </template>
            <span v-else class="gb-hint">尚未撰写礁区结论</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="openConclusion(row.id)">
              {{ gradingStore.conclusionOfReef(row.id) ? '修改结论' : '撰写结论' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 定级弹窗 -->
    <el-dialog
      v-model="gradingVisible"
      :title="`样带 ${gradingBelt?.no ?? ''} 白化定级（分级账）`"
      width="720px"
      :close-on-click-modal="false"
    >
      <el-alert
        v-if="gradingStore.gradeOfBelt(gradingBelt?.id)?.status === '待复核'"
        type="warning"
        show-icon
        :closable="false"
        title="该样带定过级后外业又补记覆盖：提交即按最新覆盖重新定级；也可以关闭弹窗后用「维持原级」。"
        class="dialog-alert"
      />
      <el-table :data="gradingCorals" border stripe size="small" max-height="320">
        <el-table-column prop="genus" label="属名" min-width="130" />
        <el-table-column prop="form" label="形态" width="90" />
        <el-table-column label="外业覆盖 (cm)" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.coverCm }}</span>
          </template>
        </el-table-column>
        <el-table-column label="分级账原等级" width="120">
          <template #default="{ row }">
            <BleachTag
              :level="gradingSnapshot.find((item) => item.id === row.id)?.bleachLevel ?? '无'"
              size="small"
              :plain="true"
            />
          </template>
        </el-table-column>
        <el-table-column label="本次定级" min-width="260">
          <template #default="{ row }">
            <el-radio-group v-model="levelForm.levels[row.id]" size="small">
              <el-radio-button v-for="level in BLEACH_LEVELS" :key="level" :value="level">{{ level }}</el-radio-button>
            </el-radio-group>
          </template>
        </el-table-column>
      </el-table>
      <div class="dialog-preview">
        <span>按当前选择预览：总体等级</span>
        <BleachTag :level="bleachGrade(previewIndex)" size="small" />
        <span class="gb-mono">白化指数 {{ previewIndex }} / 4</span>
      </div>
      <el-form label-width="80px" class="dialog-form">
        <el-form-item label="定级人" required>
          <el-input v-model="levelForm.gradedBy" maxlength="20" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="levelForm.note" maxlength="80" placeholder="如：复核确认 / 外业补记后加重" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="gradingVisible = false">取消</el-button>
        <el-button type="primary" :loading="submittingGrade" @click="submitGrading">提交定级（只写分级账）</el-button>
      </template>
    </el-dialog>

    <!-- 礁区结论弹窗 -->
    <el-dialog v-model="conclusionVisible" title="撰写 / 修改礁区结论（分级账）" width="620px">
      <el-form label-width="80px">
        <el-form-item label="礁区">
          <el-input :model-value="conclusionForm.reefName" disabled />
        </el-form-item>
        <el-form-item label="结论" required>
          <el-input v-model="conclusionForm.conclusion" type="textarea" :rows="4" maxlength="200" show-word-limit />
        </el-form-item>
        <el-form-item label="定级人">
          <el-input v-model="conclusionForm.gradedBy" maxlength="20" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="conclusionVisible = false">取消</el-button>
        <el-button type="primary" :loading="submittingConclusion" @click="submitConclusion">保存结论</el-button>
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
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.sync-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.sync-table {
  margin-top: 12px;
}

.dialog-alert {
  margin-bottom: 12px;
}

.dialog-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0;
  font-size: 13px;
  color: #4c6663;
}

.dialog-form {
  margin-top: 8px;
}
</style>
