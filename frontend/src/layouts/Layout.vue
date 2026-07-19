<template>
    <div :class="classes">
        <div v-if="! $root.socketIO.connected && ! $root.socketIO.firstConnect" class="lost-connection">
            <div class="container-fluid">
                {{ $root.socketIO.connectionErrorMsg }}
                <div v-if="$root.socketIO.showReverseProxyGuide">
                    {{ $t("reverseProxyMsg1") }} <a href="https://github.com/louislam/uptime-kuma/wiki/Reverse-Proxy" target="_blank">{{ $t("reverseProxyMsg2") }}</a>
                </div>
            </div>
        </div>

        <aside v-if="$root.loggedIn && !$root.isMobile" class="app-sidebar">
            <router-link to="/" class="brand-link">
                <span class="brand-mark-wrap">
                    <object class="brand-mark" width="34" height="34" data="/icon.svg" />
                </span>
                <span class="brand-copy">
                    <strong class="title">DockerBridge</strong>
                    <small>Local control plane</small>
                </span>
            </router-link>

            <nav class="side-nav" aria-label="Primary">
                <div class="side-section-title">工作区</div>
                <router-link v-slot="{ href, navigate }" to="/" custom>
                    <a :href="href" class="side-link" :class="{ active: $route.path === '/' }" @click="navigate">
                        <font-awesome-icon icon="tachometer-alt" />
                        <span>仪表盘</span>
                    </a>
                </router-link>
                <router-link to="/dockerbridge" class="side-link">
                    <font-awesome-icon icon="list" />
                    <span>容器管理</span>
                </router-link>
                <router-link to="/compose-management" class="side-link" :class="{ active: isComposeManagement }">
                    <font-awesome-icon icon="stream" />
                    <span>Compose 管理</span>
                </router-link>
            </nav>

            <div class="side-section">
                <div class="side-section-title">工具</div>
                <router-link to="/console" class="side-link compact">
                    <font-awesome-icon icon="terminal" />
                    <span>终端</span>
                </router-link>
                <button class="side-link compact side-button" @click="scanFolder">
                    <font-awesome-icon icon="arrows-rotate" />
                    <span>扫描 Compose</span>
                </button>
                <router-link to="/settings/general" class="side-link compact" :class="{ active: $route.path.includes('settings') }">
                    <font-awesome-icon icon="cog" />
                    <span>系统设置</span>
                </router-link>
            </div>

            <div class="sidebar-status" :class="{ online: $root.socketIO.connected }">
                <span class="status-indicator" aria-hidden="true"></span>
                <span>
                    <strong>{{ $root.socketIO.connected ? "运行服务已连接" : "连接已中断" }}</strong>
                    <small>{{ $root.socketIO.connected ? "Socket.IO active" : "正在尝试重新连接" }}</small>
                </span>
            </div>
        </aside>

        <header v-if="! $root.isMobile" class="app-header">
            <div v-if="$root.loggedIn" class="page-context">
                <strong>{{ currentPage.title }}</strong>
                <span>{{ currentPage.description }}</span>
            </div>

            <div v-if="$root.loggedIn" class="connection-state" :class="{ online: $root.socketIO.connected }">
                <span class="status-indicator" aria-hidden="true"></span>
                {{ $root.socketIO.connected ? "已连接" : "重新连接中" }}
            </div>

            <a v-if="hasNewVersion" target="_blank" href="https://github.com/kilomac/dockerbridge/releases" class="btn btn-warning me-3">
                <font-awesome-icon icon="arrow-alt-circle-up" /> {{ $t("newUpdate") }}
            </a>

            <ul class="nav nav-pills app-nav">
                <li v-if="$root.loggedIn" class="nav-item">
                    <div class="dropdown dropdown-profile-pic">
                        <div class="nav-link" data-bs-toggle="dropdown">
                            <div class="profile-pic">{{ $root.usernameFirstChar }}</div>
                            <font-awesome-icon icon="angle-down" />
                        </div>

                        <!-- Header's Dropdown Menu -->
                        <ul class="dropdown-menu">
                            <!-- Username -->
                            <li>
                                <i18n-t v-if="$root.username != null" tag="span" keypath="signedInDisp" class="dropdown-item-text">
                                    <strong>{{ $root.username }}</strong>
                                </i18n-t>
                                <span v-if="$root.username == null" class="dropdown-item-text">{{ $t("signedInDispDisabled") }}</span>
                            </li>

                            <li><hr class="dropdown-divider"></li>

                            <!-- Functions -->

                            <!--<li>
                                <router-link to="/registry" class="dropdown-item" :class="{ active: $route.path.includes('settings') }">
                                    <font-awesome-icon icon="warehouse" /> {{ $t("registry") }}
                                </router-link>
                            </li>-->

                            <li>
                                <button class="dropdown-item" @click="scanFolder">
                                    <font-awesome-icon icon="arrows-rotate" /> {{ $t("scanFolder") }}
                                </button>
                            </li>

                            <li>
                                <router-link to="/settings/general" class="dropdown-item" :class="{ active: $route.path.includes('settings') }">
                                    <font-awesome-icon icon="cog" /> {{ $t("Settings") }}
                                </router-link>
                            </li>

                            <li>
                                <button class="dropdown-item" @click="$root.logout">
                                    <font-awesome-icon icon="sign-out-alt" />
                                    {{ $t("Logout") }}
                                </button>
                            </li>
                        </ul>
                    </div>
                </li>
            </ul>
        </header>

        <header v-if="$root.loggedIn && $root.isMobile" class="mobile-header">
            <router-link to="/" class="mobile-brand" aria-label="DockerBridge 首页">
                <object width="30" height="30" data="/icon.svg" />
                <span>
                    <strong>{{ currentPage.title }}</strong>
                    <small>{{ $root.socketIO.connected ? "运行服务已连接" : "重新连接中" }}</small>
                </span>
            </router-link>
            <router-link to="/settings/general" class="mobile-profile" :aria-label="`${$root.username || '用户'}账户设置`">
                {{ $root.usernameFirstChar }}
            </router-link>
        </header>

        <main class="app-main">
            <div v-if="$root.socketIO.connecting" class="container mt-5">
                <h4>{{ $t("connecting...") }}</h4>
            </div>

            <router-view v-if="$root.loggedIn" />
            <Login v-if="! $root.loggedIn && $root.allowLoginDialog" />
        </main>

        <nav v-if="$root.loggedIn && $root.isMobile" class="bottom-nav" aria-label="移动端主导航">
            <router-link to="/" :class="{ active: $route.path === '/' }">
                <font-awesome-icon icon="tachometer-alt" />
                <span>概览</span>
            </router-link>
            <router-link to="/dockerbridge">
                <font-awesome-icon icon="list" />
                <span>容器</span>
            </router-link>
            <router-link to="/compose-management" :class="{ active: isComposeManagement }">
                <font-awesome-icon icon="stream" />
                <span>Compose</span>
            </router-link>
            <router-link to="/settings/general" :class="{ active: $route.path.includes('settings') }">
                <font-awesome-icon icon="cog" />
                <span>设置</span>
            </router-link>
        </nav>
    </div>
</template>

<script>
import Login from "../components/Login.vue";
import { compareVersions } from "compare-versions";
import { ALL_ENDPOINTS } from "../../../common/util-common";

export default {

    components: {
        Login,
    },

    data() {
        return {

        };
    },

    computed: {

        // Theme or Mobile
        classes() {
            const classes = {};
            classes[this.$root.theme] = true;
            classes["mobile"] = this.$root.isMobile;
            classes["with-sidebar"] = this.$root.loggedIn && !this.$root.isMobile;
            return classes;
        },

        hasNewVersion() {
            if (this.$root.info.latestVersion && this.$root.info.version) {
                return compareVersions(this.$root.info.latestVersion, this.$root.info.version) >= 1;
            } else {
                return false;
            }
        },

        isComposeManagement() {
            return this.$route.path === "/compose-management"
                || this.$route.path.startsWith("/compose")
                || this.$route.path.startsWith("/terminal");
        },

        currentPage() {
            if (this.$route.path === "/") {
                return {
                    title: "运行概览",
                    description: "本机 Docker 环境和 Compose 状态",
                };
            }
            if (this.$route.path.startsWith("/dockerbridge")) {
                return {
                    title: "容器管理",
                    description: "容器、镜像、端口与运行资源",
                };
            }
            if (this.isComposeManagement) {
                return {
                    title: "Compose 管理",
                    description: "发现、编辑并部署 Compose 项目",
                };
            }
            if (this.$route.path.startsWith("/console")) {
                return {
                    title: "终端",
                    description: "本机 Docker 命令行",
                };
            }
            return {
                title: "系统设置",
                description: "偏好、安全与平台配置",
            };
        },

    },

    watch: {

    },

    mounted() {

    },

    beforeUnmount() {

    },

    methods: {
        scanFolder() {
            this.$root.emitAgent(ALL_ENDPOINTS, "requestStackList", (res) => {
                this.$root.toastRes(res);
            });
        },
    },

};
</script>

<style lang="scss" scoped>
@import "../styles/vars.scss";

.nav-link {
    &.status-page {
        background-color: rgba(255, 255, 255, 0.1);
    }
}

.app-header {
    position: sticky;
    top: 0;
    z-index: 1020;
    display: flex;
    align-items: center;
    min-height: 72px;
    padding: 0 28px;
    background: rgba(244, 247, 245, 0.94);
    border-bottom: 1px solid $border-color;
    backdrop-filter: blur(14px);
    justify-content: flex-end;
}

.app-sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 1030;
    display: flex;
    flex-direction: column;
    width: 264px;
    padding: 18px 16px 16px;
    background: #f9fbfa;
    border-right: 1px solid $border-color;
}

.brand-link {
    display: flex;
    align-items: center;
    min-height: 52px;
    padding: 0 6px;
    color: $text-color;
    text-decoration: none;
}

.brand-mark-wrap {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    margin-right: 11px;
    border: 1px solid $border-color;
    border-radius: 11px;
    background: $surface;
}

.brand-copy {
    display: grid;
    gap: 1px;

    small {
        color: $muted-color;
        font-size: 11px;
        letter-spacing: 0.02em;
    }
}

.app-nav {
    align-items: center;
    gap: 6px;
    margin-left: auto;
    margin-right: 0;

    .nav-link {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 40px;
        padding: 8px 12px;
        border-radius: 8px;
        color: $muted-color;
        font-weight: 650;

        &:hover {
            color: $text-color;
            background: $surface-subtle;
        }

        &.router-link-exact-active {
            color: #0d5fb7;
            background: $highlight;
        }
    }
}

.side-nav {
    display: grid;
    gap: 6px;
    margin-top: 28px;
}

.side-section {
    display: grid;
    gap: 6px;
    margin-top: 22px;
    padding-top: 18px;
    border-top: 1px solid $border-color;
}

.side-section-title {
    padding: 0 10px 5px;
    color: $muted-color;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.04em;
}

.side-link {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 42px;
    padding: 10px 12px;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: $muted-color;
    font-weight: 650;
    text-align: left;
    text-decoration: none;

    svg {
        width: 18px;
    }

    &:hover {
        color: $text-color;
        background: $surface-muted;
        border-color: $border-color;
    }

    &.active,
    &.router-link-exact-active {
        color: #155e55;
        background: $highlight-white;
        border-color: rgba($primary, 0.22);
    }

    &.compact {
        min-height: 40px;
        font-size: 14px;
        font-weight: 700;
    }
}

.sidebar-status {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    margin-top: auto;
    padding: 12px;
    border: 1px solid $border-color;
    border-radius: 10px;
    background: $surface;

    strong,
    small {
        display: block;
    }

    strong {
        font-size: 12px;
    }

    small {
        margin-top: 2px;
        color: $muted-color;
        font-size: 11px;
    }
}

.status-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: $danger;
    box-shadow: 0 0 0 4px rgba($danger, 0.12);

    .online &,
    &.online {
        background: $primary;
        box-shadow: 0 0 0 4px rgba($primary, 0.12);
    }
}

.page-context {
    display: grid;
    gap: 1px;
    margin-right: auto;

    strong {
        font-size: 14px;
    }

    span {
        color: $muted-color;
        font-size: 12px;
    }
}

.connection-state {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-right: 14px;
    color: $muted-color;
    font-size: 12px;
    font-weight: 650;
}

.side-button {
    appearance: none;
    cursor: pointer;
}

.bottom-nav {
    z-index: 1000;
    position: fixed;
    bottom: 0;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    height: calc(66px + env(safe-area-inset-bottom));
    width: 100%;
    left: 0;
    background-color: #fff;
    border-top: 1px solid $border-color;
    box-shadow: 0 -8px 24px rgba(24, 48, 39, 0.07);
    padding: 4px 8px env(safe-area-inset-bottom);

    a {
        display: grid;
        place-items: center;
        align-content: center;
        gap: 3px;
        min-width: 0;
        padding: 5px;
        border-radius: 9px;
        color: $muted-color;
        font-size: 11px;
        text-decoration: none;

        &.router-link-exact-active, &.active {
            color: $primary;
            background: $highlight-white;
            font-weight: 700;
        }

        svg {
            font-size: 17px;
        }
    }
}

.mobile-header {
    position: sticky;
    top: 0;
    z-index: 1020;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 62px;
    padding: 8px 14px;
    border-bottom: 1px solid $border-color;
    background: rgba(249, 251, 250, 0.96);
    backdrop-filter: blur(12px);
}

.mobile-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    color: $text-color;
    text-decoration: none;

    span {
        min-width: 0;
    }

    strong,
    small {
        display: block;
    }

    strong {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    small {
        color: $muted-color;
        font-size: 11px;
    }
}

.mobile-profile {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: 1px solid rgba($primary, 0.25);
    border-radius: 50%;
    background: $highlight-white;
    color: $primary;
    font-weight: 750;
    text-decoration: none;
}

.app-main {
    min-height: calc(100vh - 68px);
    padding: 18px 0 28px;
}

.with-sidebar {
    .app-header,
    .app-main {
        margin-left: 264px;
    }
}

.mobile {
    .app-main {
        margin-left: 0;
    }
}

.title {
    font-size: 21px;
    font-weight: 800;
    letter-spacing: 0;
}

.lost-connection {
    padding: 8px;
    background-color: #a92f3b;
    color: white;
    position: fixed;
    width: 100%;
    z-index: 1080;
}

// Profile Pic Button with Dropdown
.dropdown-profile-pic {
    user-select: none;

    .nav-link {
        cursor: pointer;
        display: flex;
        gap: 6px;
        align-items: center;
        background-color: $surface-subtle;
        padding: 0.45rem 0.7rem;

        &:hover {
            background-color: $highlight;
        }
    }

    .dropdown-menu {
        transition: all 0.2s;
        padding-left: 0;
        padding-bottom: 0;
        margin-top: 8px !important;
        border-radius: 8px;
        border: 1px solid $border-color;
        box-shadow: $soft-shadow;
        overflow: hidden;

        .dropdown-divider {
            margin: 0;
            border-top: 1px solid rgba(0, 0, 0, 0.4);
            background-color: transparent;
        }

        .dropdown-item-text {
            font-size: 14px;
            padding-bottom: 0.7rem;
        }

        .dropdown-item {
            padding: 0.7rem 1rem;
        }

        .dark & {
            background-color: $dark-bg;
            color: $dark-font-color;
            border-color: $dark-border-color;

            .dropdown-item {
                color: $dark-font-color;

                &.active {
                    color: $dark-font-color2;
                    background-color: $highlight !important;
                }

                &:hover {
                    background-color: $dark-bg2;
                }
            }
        }
    }

    .profile-pic {
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        background-color: $primary;
        width: 24px;
        height: 24px;
        margin-right: 5px;
        border-radius: 50rem;
        font-weight: bold;
        font-size: 10px;
    }
}

.dark {
    .app-header {
        background-color: $dark-header-bg;
        border-bottom-color: $dark-header-bg !important;

        span {
            color: #f0f6fc;
        }
    }

    .bottom-nav {
        background-color: $dark-bg;
        border-top-color: $dark-border-color;
    }

    .mobile-header {
        background: rgba($dark-header-bg, 0.96);
        border-bottom-color: $dark-border-color;
    }

    .mobile-brand {
        color: $dark-font-color2;

        small {
            color: $dark-font-color3;
        }
    }

    .brand-link {
        color: $dark-font-color2;
    }

    .app-sidebar {
        background: $dark-header-bg;
        border-right-color: $dark-border-color;
    }

    .brand-mark-wrap,
    .sidebar-status {
        background: $dark-bg;
        border-color: $dark-border-color;
    }

    .side-section {
        border-top-color: $dark-border-color;
    }

    .side-section-title {
        color: $dark-font-color3;
    }

    .side-link {
        color: $dark-font-color3;

        &:hover {
            color: $dark-font-color;
            background: $dark-bg;
            border-color: $dark-border-color;
        }

        &.active,
        &.router-link-exact-active {
            color: $dark-font-color2;
            background: rgba($primary, 0.18);
            border-color: rgba($primary, 0.28);
        }
    }

    .app-nav {
        .nav-link {
            color: $dark-font-color3;

            &:hover {
                color: $dark-font-color;
                background: $dark-bg;
            }

            &.router-link-exact-active {
                color: $dark-font-color2;
                background: rgba(31, 143, 255, 0.18);
            }
        }
    }
}

@media (max-width: 640px) {
    .app-main {
        min-height: calc(100dvh - 128px);
        padding: 12px 0 calc(82px + env(safe-area-inset-bottom));
        margin-left: 0;
    }
}
</style>
