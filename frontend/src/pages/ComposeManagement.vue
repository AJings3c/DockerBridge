<template>
    <div class="compose-management">
        <div class="page-heading">
            <div>
                <h1>Compose 管理</h1>
                <p>集中发现、创建和维护本机 Compose 项目。</p>
            </div>
            <div class="button-row">
                <button class="btn btn-normal" @click="scanFolder">
                    <font-awesome-icon icon="arrows-rotate" />
                    扫描 Compose
                </button>
                <router-link to="/compose" class="btn btn-primary">
                    <font-awesome-icon icon="plus" />
                    新建 Compose
                </router-link>
            </div>
        </div>

        <section class="compose-overview">
            <div class="overview-copy">
                <span class="overview-icon"><font-awesome-icon icon="stream" /></span>
                <div>
                    <span>Compose 工作区</span>
                    <strong>{{ totalStacks }} 个项目</strong>
                    <small>{{ activeNum }} 个正在运行，{{ discoveredNum }} 个来自外部路径。</small>
                </div>
            </div>
            <div class="overview-stats">
                <div>
                    <strong class="running">{{ activeNum }}</strong>
                    <span>运行中</span>
                </div>
                <div>
                    <strong class="exited">{{ exitedNum }}</strong>
                    <span>已退出</span>
                </div>
                <div>
                    <strong>{{ inactiveNum }}</strong>
                    <span>未运行</span>
                </div>
            </div>
        </section>

        <div class="management-grid">
            <section class="workspace-panel project-panel">
                <div class="section-heading">
                    <div>
                        <h2>项目清单</h2>
                        <p>运行中的项目优先展示，外部 YAML 会保留原始路径。</p>
                    </div>
                </div>

                <div v-if="recentStacks.length === 0" class="empty-state">
                    <span class="empty-icon"><font-awesome-icon icon="file" /></span>
                    <strong>还没有 Compose 项目</strong>
                    <p>扫描现有目录，或者创建一个新的 compose.yaml。</p>
                    <div class="button-row">
                        <button class="btn btn-normal" @click="scanFolder">扫描 Compose</button>
                        <router-link to="/compose" class="btn btn-primary">新建 Compose</router-link>
                    </div>
                </div>
                <div v-else class="stack-table">
                    <div class="stack-table-head" aria-hidden="true">
                        <span>项目</span>
                        <span>来源</span>
                        <span>状态</span>
                        <span></span>
                    </div>
                    <router-link v-for="stack in recentStacks" :key="`${stack.name}-${stack.endpoint}`" class="stack-row" :to="stackUrl(stack)">
                        <span class="stack-name">
                            <span class="status-dot" :class="stackStateClass(stack)" aria-hidden="true"></span>
                            <span>
                                <strong>{{ stack.name }}</strong>
                                <small class="muted-path">{{ stack.composeFilePath || stack.composeFileName }}</small>
                            </span>
                        </span>
                        <span class="source-label">{{ stack.isDiscoveredCompose ? "外部 YAML" : (stack.endpoint || "本机") }}</span>
                        <span><span class="status-text" :class="stackStateClass(stack)">{{ stackStatusLabel(stack) }}</span></span>
                        <font-awesome-icon icon="chevron-circle-right" />
                    </router-link>
                </div>
            </section>

            <section class="workspace-panel converter-panel">
                <div class="section-heading">
                    <div>
                        <h2>Docker Run 转换</h2>
                        <p>把单容器命令整理为可重复部署的配置。</p>
                    </div>
                </div>
                <label class="visually-hidden" for="compose-management-docker-run">Docker Run 命令</label>
                <textarea id="compose-management-docker-run" v-model="dockerRunCommand" class="form-control docker-run" placeholder="docker run --name app -p 8080:80 nginx:latest"></textarea>
                <button class="btn btn-primary convert-button" :disabled="!dockerRunCommand.trim()" @click="convertDockerRun">
                    转换为 Compose
                    <font-awesome-icon icon="chevron-circle-right" />
                </button>
            </section>
        </div>
    </div>
</template>

<script>
import { ALL_ENDPOINTS, EXITED, RUNNING, statusNameShort } from "../../../common/util-common";

export default {
    data() {
        return {
            dockerRunCommand: "",
        };
    },
    computed: {
        stacks() {
            return Object.values(this.$root.completeStackList);
        },
        totalStacks() {
            return this.stacks.length;
        },
        activeNum() {
            return this.getStatusNum("active");
        },
        inactiveNum() {
            return this.getStatusNum("inactive");
        },
        exitedNum() {
            return this.getStatusNum("exited");
        },
        discoveredNum() {
            return this.stacks.filter(stack => stack.isDiscoveredCompose).length;
        },
        recentStacks() {
            return [ ...this.stacks ]
                .sort((a, b) => {
                    if (a.status === RUNNING && b.status !== RUNNING) {
                        return -1;
                    }
                    if (a.status !== RUNNING && b.status === RUNNING) {
                        return 1;
                    }
                    return a.name.localeCompare(b.name);
                })
                .slice(0, 12);
        },
    },
    methods: {
        getStatusNum(statusName) {
            return this.stacks.filter(stack => statusNameShort(stack.status) === statusName).length;
        },
        stackUrl(stack) {
            return stack.endpoint ? `/compose/${stack.name}/${stack.endpoint}` : `/compose/${stack.name}`;
        },
        stackStatusLabel(stack) {
            if (stack.status === RUNNING) {
                return "运行中";
            }
            if (stack.status === EXITED) {
                return "已退出";
            }
            return "未运行";
        },
        stackBadgeClass(stack) {
            if (stack.status === RUNNING) {
                return "bg-primary";
            }
            if (stack.status === EXITED) {
                return "bg-danger";
            }
            return "bg-secondary";
        },
        stackStateClass(stack) {
            if (stack.status === RUNNING) {
                return "running";
            }
            if (stack.status === EXITED) {
                return "exited";
            }
            return "inactive";
        },
        scanFolder() {
            this.$root.emitAgent(ALL_ENDPOINTS, "requestStackList", (res) => {
                this.$root.toastRes(res);
            });
        },
        convertDockerRun() {
            if (!this.dockerRunCommand.trim() || this.dockerRunCommand.trim() === "docker run") {
                this.$root.toastError("请输入 docker run 命令");
                return;
            }

            this.$root.getSocket().emit("composerize", this.dockerRunCommand, (res) => {
                if (res.ok) {
                    this.$root.composeTemplate = res.composeTemplate;
                    this.$router.push("/compose");
                } else {
                    this.$root.toastRes(res);
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars";

.compose-management {
    display: grid;
    gap: 16px;

    h1 {
        margin: 0;
    }

    p {
        margin: 5px 0 0;
        color: $muted-color;
    }
}

.page-heading,
.section-heading,
.button-row,
.stack-row {
    display: flex;
    align-items: center;
    gap: 12px;
}

.page-heading {
    justify-content: space-between;
}

.button-row {
    flex-wrap: wrap;
}

.compose-overview {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 24px;
    padding: 20px;
    border: 1px solid $border-color;
    border-radius: 12px;
    background: $surface;

    .dark & {
        background: $dark-bg;
        border-color: $dark-border-color;
    }
}

.overview-copy {
    display: flex;
    align-items: center;
    gap: 14px;

    span,
    strong,
    small {
        display: block;
    }

    span,
    small {
        color: $muted-color;
    }

    strong {
        margin: 1px 0 2px;
        font-size: 22px;
    }
}

.overview-icon {
    display: grid !important;
    flex: 0 0 auto;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 10px;
    background: $highlight-white;
    color: $primary !important;
    font-size: 18px;

    .dark & {
        background: rgba($primary, 0.15);
    }
}

.overview-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(80px, 1fr));

    div {
        display: grid;
        gap: 2px;
        min-width: 92px;
        padding: 2px 18px;
        border-left: 1px solid $border-color;
    }

    strong {
        font-size: 22px;
    }

    span {
        color: $muted-color;
        font-size: 11px;
    }

    .running {
        color: $primary;
    }

    .exited {
        color: $danger;
    }

    .dark & div {
        border-color: $dark-border-color;
    }
}

.management-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(300px, 0.6fr);
    gap: 16px;
}

.workspace-panel {
    min-width: 0;
    padding: 20px;
    border: 1px solid $border-color;
    border-radius: 12px;
    background: $surface;

    .dark & {
        background: $dark-bg;
        border-color: $dark-border-color;
    }
}

.section-heading {
    justify-content: space-between;
    margin-bottom: 18px;

    h2 {
        margin: 0;
        font-size: 18px;
    }

    p {
        font-size: 12px;
    }
}

.docker-run {
    min-height: 180px;
    font-family: $mono-font;
    font-size: 13px;
    line-height: 1.6;
    background: #101714;
    color: #dce8e3;
    border: 1px solid #293a34;

    &::placeholder {
        color: #95a39e;
    }
}

.convert-button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    margin-top: 12px;
}

.stack-table {
    overflow: hidden;
    border: 1px solid $border-color;
    border-radius: 10px;

    .dark & {
        border-color: $dark-border-color;
    }
}

.stack-table-head,
.stack-row {
    display: grid;
    grid-template-columns: minmax(240px, 1.5fr) minmax(100px, 0.55fr) minmax(90px, 0.4fr) 18px;
    gap: 14px;
    align-items: center;
}

.stack-table-head {
    min-height: 38px;
    padding: 8px 14px;
    border-bottom: 1px solid $border-color;
    background: $surface-muted;
    color: $muted-color;
    font-size: 11px;
    font-weight: 700;

    .dark & {
        background: $dark-bg2;
        border-color: $dark-border-color;
    }
}

.stack-row {
    min-height: 66px;
    padding: 10px 14px;
    border-bottom: 1px solid $border-color;
    color: inherit;
    text-decoration: none;
    transition: background-color 160ms ease;

    &:last-child {
        border-bottom: 0;
    }

    &:hover {
        background: $surface-muted;
    }

    .dark & {
        border-color: $dark-border-color;

        &:hover {
            background: $dark-bg2;
        }
    }

    > svg {
        color: $muted-color;
    }
}

.stack-name {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;

    > span:last-child {
        min-width: 0;
    }

    strong,
    small {
        display: block;
    }
}

.status-dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: $muted-color;

    &.running {
        background: $primary;
    }

    &.exited {
        background: $danger;
    }
}

.source-label,
.status-text {
    color: $muted-color;
    font-size: 12px;
}

.status-text {
    display: inline-flex;
    padding: 4px 8px;
    border-radius: 6px;
    background: $surface-subtle;

    &.running {
        color: #155e55;
        background: $success-surface;
    }

    &.exited {
        color: #8a2f39;
        background: $danger-surface;
    }
}

.muted-path {
    max-width: 100%;
    overflow: hidden;
    color: $muted-color;
    font-family: $mono-font;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.empty-state {
    display: grid;
    justify-items: center;
    gap: 8px;
    color: $muted-color;
    padding: 48px 20px;
    text-align: center;

    strong {
        color: $text-color;
        font-size: 16px;
    }

    p {
        margin: 0;
    }
}

.empty-icon {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    margin-bottom: 4px;
    border-radius: 11px;
    background: $surface-subtle;
    color: $primary;
}

@media (max-width: 980px) {
    .management-grid {
        grid-template-columns: 1fr;
    }

    .compose-overview {
        grid-template-columns: 1fr;
    }

    .overview-stats div:first-child {
        border-left: 0;
        padding-left: 0;
    }
}

@media (max-width: 640px) {
    .page-heading {
        align-items: stretch;
        flex-direction: column;
    }

    .button-row {
        display: grid;
        grid-template-columns: 1fr 1fr;

        .btn {
            padding: 8px;
        }
    }

    .compose-overview,
    .workspace-panel {
        padding: 16px;
    }

    .overview-copy {
        align-items: flex-start;
    }

    .overview-stats {
        grid-template-columns: repeat(3, 1fr);

        div {
            min-width: 0;
            padding: 2px 10px;
        }
    }

    .stack-table {
        border: 0;
    }

    .stack-table-head {
        display: none;
    }

    .stack-row {
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 6px 10px;
        margin-bottom: 8px;
        border: 1px solid $border-color;
        border-radius: 9px;

        &:last-child {
            border-bottom: 1px solid $border-color;
        }

        .source-label {
            grid-column: 1;
            padding-left: 18px;
        }

        > span:nth-child(3) {
            grid-row: 1;
            grid-column: 2;
        }

        > svg {
            display: none;
        }
    }
}
</style>
