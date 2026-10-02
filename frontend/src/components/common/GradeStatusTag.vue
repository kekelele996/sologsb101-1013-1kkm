<script setup lang="ts">
/**
 * <GradeStatusTag> 样带定级状态徽标：未定级 / 已定级 / 待复核 / 有分歧。
 * 外业与分级两侧页面共用，悬停可看该状态的处置口径。
 */
import { computed } from 'vue'
import { GRADE_STATUS_META, type GradeStatus } from '@/types/grading'

const props = withDefaults(
  defineProps<{
    status: GradeStatus
    size?: 'small' | 'default'
  }>(),
  { size: 'default' }
)

const meta = computed(() => GRADE_STATUS_META[props.status])
</script>

<template>
  <el-tooltip :content="meta.hint" placement="top">
    <el-tag :type="meta.type" :size="size" effect="light" class="grade-status-tag">
      {{ status }}
    </el-tag>
  </el-tooltip>
</template>

<style scoped>
.grade-status-tag {
  white-space: nowrap;
}
</style>
