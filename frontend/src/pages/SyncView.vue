<script setup lang="ts">
/**
 * 模块 7：/sync 同步对账
 * 外业份与分级份各自持有自己那份：外业写入先进离线待同步队列，网络恢复后按样带编号与分级组对账。
 * - 待同步队列：断网照旧记账，同步中断留外业重试；
 * - 待处理问题：待复核 / 对账不符，留人工定论（分级份那份照旧，不被外业覆盖）；
 * - 分级组礁区结论：分级份出具的结论（只读）。
 */
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, RefreshRight, Connection, Link } from '@element-plus/icons-vue'
import SyncBadge from '@/components/common/SyncBadge.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useSyncStore } from '@/stores/syncStore'
import { useReefStore } from '@/stores/reefStore'
import {
  ISSUE_RESOLUTION_LABEL,
  ISSUE_TYPE_LABEL,
  parseCoverSnapshot,
  type IssueResolution,
  type OutboxEntry,
  type ReconcileIssue
} from '@/types/sync'

const syncStore = useSyncStore()
const reefStore = useReefStore()
const { online, syncing, simulateInterrupt, pendingCount, failedCount, openIssueCount, syncedCount, openIssues } =
  storeToRefs(syncStore)

const activeTab = ref('issues')

const pendingEntries = computed(() =>
  syncStore.outbox.filter((entry) => entry.status === 'pending' || entry.status === 'failed')
)
const syncedEntries = computed(() =>
  [...syncStore.outbox]
    .filter((entry) => entry.status === 'synced')
    .sort((a, b) => (b.syncedAt ?? 0) - (a.syncedAt ?? 0))
    .slice(0, 50)
)

const reefNameOf = (reefId: string): string => reefStore.reefById(reefId)?.name ?? '未知礁区'

const entityLabel = (entry: OutboxEntry): string => {
  if (entry.entityType === 'belt') return '样带'
  if (entry.entityType === 'coral') return '珊瑚记录'
  return '鱼类计数'
}

const actionLabel = (action: OutboxEntry['action']): string => {
  if (action === 'create') return '新增'
  if (action === 'update') return '修改'
  return '删除'
}

/** 解析外业载荷为可读摘要 */
function summarizePayload(raw: string): string {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if ('genus' in obj) {
      return `珊瑚 ${String(obj.genus)} / ${String(obj.form ?? '')} / 覆盖 ${String(obj.coverCm ?? 0)} cm / 外业初判 ${String(obj.bleachLevel ?? '无')}`
    }
    if ('family' in obj) {
      return `鱼类 ${String(obj.family)} / ${String(obj.count ?? 0)} 尾 / ${String(obj.sizeClass ?? '')}`
    }
    if ('no' in obj) {
      return `样带 ${String(obj.no)} / ${String(obj.lengthM ?? 0)} m / ${String(obj.orientation ?? '')}向 / ${String(obj.surveyDate ?? '')}`
    }
    return '—'
  } catch {
    return '—'
  }
}

/** 解析分级份载荷为可读摘要 */
function summarizeGrade(raw: string): string {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if ('bleachLevel' in obj) return `分级定级：${String(obj.bleachLevel)}${obj.conclusion ? `（${String(obj.conclusion)}）` : ''}`
    return '—'
  } catch {
    return '—'
  }
}

/** 定级时的珊瑚覆盖快照摘要 */
function gradeCoverSummary(issue: ReconcileIssue): string {
  try {
    const grade = JSON.parse(issue.gradingPayload) as Record<string, unknown>
    const snap = parseCoverSnapshot(typeof grade.coverSnapshot === 'string' ? grade.coverSnapshot : '[]')
    if (snap.length === 0) return '定级时无珊瑚覆盖记录'
    return `定级时覆盖：${snap.map((item) => `${item.genus} ${item.coverCm}cm`).join('；')}`
  } catch {
    return ''
  }
}

async function handleSync(): Promise<void> {
  const result = await syncStore.syncNow()
  if (result.failed > 0) {
    ElMessage.warning(`对账完成：送达 ${result.delivered} 条，${result.failed} 条中断留待重试`)
  } else if (result.delivered > 0) {
    ElMessage.success(`对账完成：已送达 ${result.delivered} 条外业改动，分级份照旧`)
  } else {
    ElMessage.info('没有待同步的外业改动')
  }
}

async function handleRetry(): Promise<void> {
  const result = await syncStore.retryFailed()
  if (result.failed > 0) ElMessage.warning(`仍有 ${result.failed} 条中断，可继续重试`)
  else ElMessage.success('中断条目已全部重试送达')
}

async function handleResolve(issue: ReconcileIssue, resolution: IssueResolution): Promise<void> {
  const label = ISSUE_RESOLUTION_LABEL[resolution]
  try {
    await ElMessageBox.confirm(
      `将按「${label}」定论样带 ${issue.beltNo} 的${ISSUE_TYPE_LABEL[issue.type]}。定论后分级份按规则处理，外业份不被丢弃。确认？`,
      '人工定论确认',
      { type: 'warning', confirmButtonText: '确认定论', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await syncStore.resolveIssue(issue.id, resolution)
  ElMessage.success(`已按「${label}」定论`)
}

const resolutionButtons = (issue: ReconcileIssue): Array<{ key: IssueResolution; label: string; type: 'primary' | 'success' | 'warning' | 'info' }> => {
  if (issue.type === 'grade_conflict') {
    return [
      { key: 'field_wins', label: '以外业覆盖为准（重评）', type: 'primary' },
      { key: 'grading_wins', label: '以分级定级为准（回退外业）', type: 'success' },
      { key: 'manual_keep', label: '人工已核对，维持现状', type: 'info' }
    ]
  }
  return [
    { key: 'resubmit_grading', label: '提交分级组重评', type: 'warning' },
    { key: 'revert_field', label: '按分级记录回退', type: 'success' },
    { key: 'manual_keep', label: '人工已核对，维持现状', type: 'info' }
  ]
}

onMounted(() => {
  syncStore.start()
  if (reefStore.reefs.length === 0) reefStore.start()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">同步对账</h2>
        <p class="gb-hint">
          外业队管样带与珊瑚覆盖，分级组管白化等级与礁区结论，两边各自持有自己那份。现场断网照旧记账，网络恢复后按样带编号对账；对不上的等人定，分级组那份照旧。
        </p>
      </div>
      <div class="page__actions">
        <el-tag :type="online ? 'success' : 'info'" effect="dark" size="large">
          <el-icon class="page__online-icon"><component :is="online ? Connection : Link" /></el-icon>
          {{ online ? '网络已恢复' : '现场断网中' }}
        </el-tag>
        <el-button type="primary" :icon="Refresh" :loading="syncing" @click="handleSync">网络恢复 · 立即对账</el-button>
      </div>
    </div>

    <el-alert
      v-if="!online"
      type="info"
      show-icon
      :closable="false"
      title="当前处于断网状态：外业写入会先进入待同步队列，不会丢失。恢复网络后点击「立即对账」按样带编号与分级组对账。"
    />

    <div class="gb-stats-row">
      <StatBadge label="待同步" :value="pendingCount" suffix="条" icon="Loading" tone="info" />
      <StatBadge label="同步中断" :value="failedCount" suffix="条" icon="RefreshRight" tone="danger" />
      <StatBadge label="待复核 / 对账不符" :value="openIssueCount" suffix="条" icon="WarningFilled" tone="warning" />
      <StatBadge label="已对账" :value="syncedCount" suffix="条" icon="Check" tone="success" />
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="page__simulate">
        <span class="gb-hint">演示用：</span>
        <el-switch v-model="simulateInterrupt" active-text="模拟链路中断（对账每轮投递 2 条后中断，条目留待重试）" />
      </div>
    </el-card>

    <el-tabs v-model="activeTab" class="page__tabs">
      <el-tab-pane name="issues">
        <template #label>
          <span>待处理对账问题</span>
          <el-badge v-if="openIssueCount > 0" :value="openIssueCount" class="page__tab-badge" type="danger" />
        </template>

        <EmptyPanel
          v-if="openIssues.length === 0"
          title="没有待处理的对账问题"
          description="外业改动与分级份记录一致，或尚未改动已定级样带。已定级样带被外业改动后会在这里转待复核 / 对账不符。"
          compact
        />

        <div v-else class="issue-list">
          <el-card v-for="issue in openIssues" :key="issue.id" shadow="hover" class="issue-card">
            <div class="issue-card__head">
              <el-tag :type="issue.type === 'grade_conflict' ? 'danger' : 'warning'" effect="dark">
                {{ ISSUE_TYPE_LABEL[issue.type] }}
              </el-tag>
              <strong>样带 {{ issue.beltNo }}</strong>
              <span class="gb-hint">站位 {{ issue.siteNo }} · {{ reefNameOf(issue.reefId) }}</span>
            </div>
            <p class="issue-card__summary">{{ issue.summary }}</p>
            <el-descriptions :column="1" border size="small" class="issue-card__diff">
              <el-descriptions-item label="外业份（现场补记）">
                <span class="gb-mono">{{ summarizePayload(issue.fieldPayload) }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="分级份（已定级，照旧）">
                <span class="gb-mono">{{ summarizeGrade(issue.gradingPayload) }}</span>
                <div v-if="issue.type === 'grade_conflict'" class="gb-hint">{{ gradeCoverSummary(issue) }}</div>
              </el-descriptions-item>
            </el-descriptions>
            <div class="issue-card__actions">
              <el-button
                v-for="btn in resolutionButtons(issue)"
                :key="btn.key"
                size="small"
                :type="btn.type"
                @click="handleResolve(issue, btn.key)"
              >
                {{ btn.label }}
              </el-button>
            </div>
          </el-card>
        </div>
      </el-tab-pane>

      <el-tab-pane name="pending">
        <template #label>
          <span>待同步队列</span>
          <el-badge v-if="pendingCount + failedCount > 0" :value="pendingCount + failedCount" class="page__tab-badge" type="warning" />
        </template>

        <EmptyPanel
          v-if="pendingEntries.length === 0"
          title="待同步队列为空"
          description="外业写入都会先进入这里，断网时照旧记账，网络恢复后自动对账。"
          compact
        />

        <el-table v-else :data="pendingEntries" border stripe class="gb-table-compact">
          <el-table-column label="状态" width="150">
            <template #default="{ row }">
              <SyncBadge :state="row.status === 'failed' ? 'failed' : 'pending'" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="样带编号" width="110">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.beltNo || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="站位" width="100">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.siteNo || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="内容" min-width="260">
            <template #default="{ row }">
              <div>{{ entityLabel(row) }} · {{ actionLabel(row.action) }}</div>
              <div class="gb-hint gb-mono">{{ summarizePayload(row.payload) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="重试" width="80" align="right">
            <template #default="{ row }">
              <el-button v-if="row.status === 'failed'" size="small" type="danger" @click="handleRetry">重试</el-button>
              <span v-else class="gb-hint">—</span>
            </template>
          </el-table-column>
        </el-table>

        <el-alert
          v-if="failedCount > 0"
          type="error"
          show-icon
          :closable="false"
          class="page__retry-alert"
          title="同步中断的条目会留在外业队列，不会丢失；恢复后点「重试」继续，分级组那份始终照旧。"
        />
      </el-tab-pane>

      <el-tab-pane name="synced">
        <template #label>
          <span>已对账记录</span>
          <el-badge :value="syncedCount" class="page__tab-badge" type="success" />
        </template>
        <EmptyPanel
          v-if="syncedEntries.length === 0"
          title="还没有已对账记录"
          description="网络恢复并对账后，外业改动会出现在这里。"
          compact
        />
        <el-table v-else :data="syncedEntries" border stripe class="gb-table-compact">
          <el-table-column label="样带编号" width="110">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.beltNo || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="内容" min-width="280">
            <template #default="{ row }">
              <div>{{ entityLabel(row) }} · {{ actionLabel(row.action) }}</div>
              <div class="gb-hint gb-mono">{{ summarizePayload(row.payload) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="送达时间" width="180">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.syncedAt ? new Date(row.syncedAt).toLocaleString('zh-CN') : '—' }}</span>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane name="conclusions" label="分级组礁区结论">
        <EmptyPanel
          v-if="syncStore.conclusions.length === 0"
          title="还没有礁区结论"
          description="分级组在覆盖度汇总页出具礁区结论后会显示在这里。"
          compact
        />
        <div v-else class="conclusion-list">
          <el-card v-for="c in syncStore.conclusions" :key="c.id" shadow="never" class="conclusion-card">
            <div class="conclusion-card__head">
              <strong>{{ reefNameOf(c.reefId) }}</strong>
              <span class="gb-hint">{{ c.updatedBy }} · {{ new Date(c.updatedAt).toLocaleString('zh-CN') }}</span>
            </div>
            <p class="conclusion-card__text">{{ c.conclusion }}</p>
          </el-card>
        </div>
      </el-tab-pane>
    </el-tabs>
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
  align-items: center;
  gap: 8px;
}

.page__online-icon {
  margin-right: 4px;
  vertical-align: -2px;
}

.page__simulate {
  display: flex;
  align-items: center;
  gap: 8px;
}

.page__tabs {
  margin-top: -4px;
}

.page__tab-badge {
  margin-left: 6px;
}

.issue-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.issue-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.issue-card__summary {
  margin: 0 0 10px;
  font-size: 13px;
  color: #10312f;
}

.issue-card__diff {
  margin-bottom: 10px;
}

.issue-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__retry-alert {
  margin-top: 12px;
}

.conclusion-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.conclusion-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.conclusion-card__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: #10312f;
}
</style>
