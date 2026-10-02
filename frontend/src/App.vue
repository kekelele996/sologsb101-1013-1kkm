<script setup lang="ts">
/**
 * 应用外壳：顶部导航（路由跳转 + 数据概览）、当前上下文快捷入口与页脚。
 * 层级路由统一归属到父级导航项，保证任意深链页面都能一键跳走。
 */
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DataLine, DocumentChecked, Files, Grid, Odometer, PieChart, Promotion } from '@element-plus/icons-vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useGradingStore } from '@/stores/gradingStore'
import { useSyncStore } from '@/stores/syncStore'
import { DB_NAME, DB_VERSION } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const surveyStore = useSurveyStore()
const gradingStore = useGradingStore()
const syncStore = useSyncStore()

onMounted(() => {
  reefStore.start()
  beltStore.start()
  surveyStore.start()
  gradingStore.start()
  syncStore.start()
})

/** 层级路由统一归属到最上层导航项 */
const activeKey = computed(() => {
  if (route.path.startsWith('/reefs/')) return '/reefs'
  if (route.path.startsWith('/sites/')) return '/reefs'
  if (route.path.startsWith('/belts/')) return '/coverage'
  return route.path
})

const navItems = computed(() => [
  { key: '/reefs', label: '礁区台账', icon: Odometer, badge: String(reefStore.reefs.length) },
  { key: '/coverage', label: '外业覆盖度', icon: PieChart, badge: String(surveyStore.corals.length) },
  {
    key: '/grading',
    label: '分级组工作台',
    icon: DocumentChecked,
    badge: syncStore.pendingCount + syncStore.openIssues.length > 0
      ? `箱${syncStore.pendingCount}/裁${syncStore.openIssues.length}`
      : String(gradingStore.beltGrades.length)
  }
])

/** 当前上下文的快捷入口：礁区 → 站位 → 样带 → 珊瑚/鱼类 */
const contextLinks = computed(() => {
  const links: Array<{ label: string; path: string }> = []
  const id = route.params.id as string | undefined
  if (route.path.startsWith('/reefs/') && id) {
    links.push({ label: '该礁区站位', path: `/reefs/${id}/sites` })
  }
  if (route.path.startsWith('/sites/') && id) {
    const site = reefStore.siteById(id)
    if (site) links.push({ label: '所属礁区站位', path: `/reefs/${site.reefId}/sites` })
    links.push({ label: '该站位样带', path: `/sites/${id}/belts` })
  }
  if (route.path.startsWith('/belts/') && id) {
    const belt = beltStore.beltById(id)
    if (belt) links.push({ label: '所属站位样带', path: `/sites/${belt.siteId}/belts` })
    links.push({ label: '珊瑚覆盖', path: `/belts/${id}/corals` })
    links.push({ label: '鱼类计数', path: `/belts/${id}/fishes` })
    links.push({ label: '去分级组定级', path: '/grading' })
  }
  if (route.path.startsWith('/coverage')) links.push({ label: '礁区台账', path: '/reefs' })
  if (route.path.startsWith('/grading')) {
    links.push({ label: '外业覆盖度', path: '/coverage' })
    links.push({ label: '礁区台账', path: '/reefs' })
  }
  return links
})

function go(path: string): void {
  void router.push(path)
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="app-header__brand">
        <span class="app-header__mark">珊</span>
        <div>
          <h1 class="app-header__title">珊瑚礁样带普查与白化分级台</h1>
          <p class="app-header__sub">外业队管样带与珊瑚覆盖 · 分级组管白化等级与礁区结论 · 断网发件箱对账</p>
        </div>
      </div>
      <nav class="app-nav">
        <span class="app-nav__net" :class="syncStore.online ? 'is-online' : 'is-offline'">
          <el-icon><Promotion /></el-icon>
          {{ syncStore.online ? '在线' : '断网记账中' }}
          <em v-if="syncStore.pendingCount > 0" class="app-nav__net-badge">发件箱 {{ syncStore.pendingCount }}</em>
        </span>
        <button
          v-for="item in navItems"
          :key="item.key"
          class="app-nav__item"
          :class="{ 'is-active': activeKey === item.key }"
          type="button"
          @click="go(item.key)"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
          <em v-if="item.badge" class="app-nav__badge">{{ item.badge }}</em>
        </button>
      </nav>
    </header>

    <div v-if="contextLinks.length > 0" class="app-context">
      <span class="app-context__label">当前上下文：</span>
      <el-button v-for="link in contextLinks" :key="link.path" size="small" text type="primary" @click="go(link.path)">
        {{ link.label }}
      </el-button>
    </div>

    <main class="app-main">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>

    <footer class="app-footer">
      <span>
        本地库 {{ DB_NAME }} · 结构版本 v{{ DB_VERSION }} · 数据仅存于本浏览器 IndexedDB，不上传任何服务器。
      </span>
      <span>
        外业账：礁区 {{ reefStore.reefs.length }} · 站位 {{ reefStore.sites.length }} · 样带 {{ beltStore.belts.length }}
        · 珊瑚覆盖 {{ surveyStore.corals.length }} · 计数 {{ surveyStore.fishes.length }}
        ｜分级账：定级 {{ gradingStore.beltGrades.filter((row) => row.status === '已定级').length }}
        · 待复核 {{ gradingStore.beltGrades.filter((row) => row.status === '待复核').length }}
        · 分歧 {{ gradingStore.beltGrades.filter((row) => row.status === '有分歧').length }}
        · 礁区结论 {{ gradingStore.reefConclusions.length }}
      </span>
    </footer>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.app-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 24px;
  background: linear-gradient(120deg, #08403e 0%, #0b5d5a 55%, #137a74 100%);
  color: #eafaf7;
}

.app-header__brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-header__mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.3);
  font-size: 20px;
  font-weight: 700;
}

.app-header__title {
  margin: 0;
  font-size: 18px;
  letter-spacing: 1px;
}

.app-header__sub {
  margin: 2px 0 0;
  font-size: 12px;
  letter-spacing: 1px;
  color: rgba(234, 250, 247, 0.75);
}

.app-nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.app-nav__net {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid rgba(255, 255, 255, 0.22);
}

.app-nav__net.is-online {
  background: rgba(255, 255, 255, 0.1);
  color: #d9fff5;
}

.app-nav__net.is-offline {
  background: rgba(255, 196, 120, 0.22);
  color: #ffe2bd;
  border-color: rgba(255, 200, 140, 0.55);
}

.app-nav__net-badge {
  font-style: normal;
  margin-left: 2px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.22);
}

.app-nav__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #eafaf7;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.app-nav__item:hover {
  background: rgba(255, 255, 255, 0.16);
}

.app-nav__item.is-active {
  background: #eafaf7;
  color: #0b5d5a;
  font-weight: 600;
}

.app-nav__badge {
  font-style: normal;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.18);
}

.app-context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 24px 0;
}

.app-context__label {
  font-size: 12px;
  color: #4c6663;
}

.app-main {
  flex: 1;
  width: 100%;
  max-width: 1360px;
  margin: 0 auto;
  padding: 16px 24px 32px;
}

.app-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 24px 20px;
  font-size: 12px;
  color: #6b8a86;
}
</style>
