<template>
    <div class="dashboard-shell">
        <div class="dashboard-grid" :class="{ 'with-stack-sidebar': showStackSidebar && !$root.isMobile }">
            <aside v-if="!$root.isMobile && showStackSidebar" class="stack-sidebar">
                <div class="sidebar-toolbar">
                    <router-link to="/compose" class="btn btn-primary compose-button">
                        <font-awesome-icon icon="plus" /> 新建 Compose
                    </router-link>
                </div>
                <StackList :scrollbar="true" />
            </aside>

            <section ref="container" class="dashboard-content">
                <!-- Add :key to disable vue router re-use the same component -->
                <router-view :key="$route.fullPath" :calculatedHeight="height" />
            </section>
        </div>
    </div>
</template>

<script>

import StackList from "../components/StackList.vue";

export default {
    components: {
        StackList,
    },
    data() {
        return {
            height: 0
        };
    },
    computed: {
        showStackSidebar() {
            return this.$route.path === "/compose-management"
                || this.$route.path.startsWith("/compose")
                || this.$route.path.startsWith("/terminal");
        },
    },
    mounted() {
        this.height = this.$refs.container.offsetHeight;
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.dashboard-shell {
    width: min(1880px, calc(100vw - 296px));
    margin: 0 auto;
}

.dashboard-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 18px;
    align-items: start;
}

.dashboard-grid.with-stack-sidebar {
    grid-template-columns: minmax(280px, 340px) minmax(0, 1fr);
}

.stack-sidebar {
    position: sticky;
    top: 86px;
}

.sidebar-toolbar {
    display: flex;
    align-items: center;
    margin-bottom: 12px;
}

.compose-button {
    width: 100%;
    display: inline-flex;
    justify-content: center;
    align-items: center;
    gap: 8px;
    min-height: 42px;
}

.dashboard-content {
    min-width: 0;
}

@media (max-width: 767px) {
    .dashboard-shell {
        width: min(100vw - 20px, 760px);
    }

    .dashboard-grid {
        display: block;
    }
}
</style>
