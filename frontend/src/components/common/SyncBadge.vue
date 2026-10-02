<script setup lang="ts">
/**
 * <SyncBadge> 样带外业同步状态徽标。
 * 外业份改动经待同步队列与分级组对账后的状态：
 * - synced 已对账（外业份已送达，分级份照旧）
 * - pending 待同步（现场断网记账中，网络恢复后对账）
 * - failed 同步中断（留外业重试）
 * - review 待复核（已定级样带被外业改动）
 * - conflict 对账不符（外业覆盖与分级定级对不上，留人工定论）
 */
import { computed } from 'vue'
import { Check, Loading, RefreshRight, Warning, WarningFilled } from '@element-plus/icons-vue'

export type BeltSyncState = 'synced' | 'pending' | 'failed' | 'review' | 'conflict'

const props = defineProps<{
  state: BeltSyncState
  size?: 'default' | 'small'
}>()

const config = computed(() => {
  switch (props.state) {
    case 'pending':
      return { label: '待同步', type: 'info' as const, icon: Loading }
    case 'failed':
      return { label: '同步中断 · 待重试', type: 'danger' as const, icon: RefreshRight }
    case 'review':
      return { label: '待复核', type: 'warning' as const, icon: Warning }
    case 'conflict':
      return { label: '对账不符', type: 'danger' as const, icon: WarningFilled }
    case 'synced':
    default:
      return { label: '已对账', type: 'success' as const, icon: Check }
  }
})
</script>

<template>
  <el-tag
    class="sync-badge"
    :class="[`is-${size}`]"
    :type="config.type"
    :effect="state === 'synced' ? 'light' : 'dark'"
    :disable-transitions="true"
  >
    <el-icon class="sync-badge__icon"><component :is="config.icon" /></el-icon>
    <span>{{ config.label }}</span>
  </el-tag>
</template>

<style scoped>
.sync-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}

.sync-badge.is-default {
  padding: 2px 10px;
  font-size: 13px;
  line-height: 20px;
}

.sync-badge__icon {
  font-size: 13px;
}
</style>
