<template>
    <transition ref="tableContainer" name="slide-fade" appear>
        <div v-if="$route.name === 'DashboardHome'" class="dashboard-home">
            <div class="page-heading">
                <div>
                    <h1>运行概览</h1>
                    <p>一眼确认本机 Docker 状态，快速进入需要处理的工作。</p>
                </div>
                <div class="page-actions">
                    <router-link to="/dockerbridge" class="btn btn-normal">
                        查看全部容器
                        <font-awesome-icon icon="chevron-circle-right" />
                    </router-link>
                    <router-link to="/compose" class="btn btn-primary">
                        <font-awesome-icon icon="plus" />
                        新建 Compose
                    </router-link>
                </div>
            </div>

            <section class="runtime-overview" :class="runtimeTone">
                <div class="runtime-summary">
                    <span class="runtime-icon" aria-hidden="true">
                        <font-awesome-icon :icon="abnormalContainerTotal ? 'exclamation-circle' : 'check-circle'" />
                    </span>
                    <div>
                        <div class="runtime-kicker">本机 Docker</div>
                        <h2>{{ runtimeHeadline }}</h2>
                        <p>{{ runningContainerTotal }} / {{ containerTotal }} 个容器正在运行，当前管理 {{ imageTotal }} 个镜像。</p>
                    </div>
                </div>

                <div class="resource-summary">
                    <div class="resource-item">
                        <div class="resource-label">
                            <span>CPU</span>
                            <strong>{{ cpuPercent }}%</strong>
                        </div>
                        <div class="resource-track" role="progressbar" aria-label="CPU 使用率" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="cpuPercent">
                            <span :style="{ width: `${cpuPercent}%` }"></span>
                        </div>
                    </div>
                    <div class="resource-item">
                        <div class="resource-label">
                            <span>内存</span>
                            <strong>{{ memoryPercent }}%</strong>
                        </div>
                        <div class="resource-track" role="progressbar" aria-label="内存使用率" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="memoryPercent">
                            <span :style="{ width: `${memoryPercent}%` }"></span>
                        </div>
                    </div>
                </div>
            </section>

            <div class="metric-strip" aria-label="运行指标">
                <router-link to="/dockerbridge" class="metric-item">
                    <span>容器</span>
                    <strong>{{ containerTotal }}</strong>
                    <small>{{ runningContainerTotal }} 运行中</small>
                </router-link>
                <router-link to="/dockerbridge" class="metric-item" :class="{ alert: abnormalContainerTotal > 0 }">
                    <span>需关注</span>
                    <strong>{{ abnormalContainerTotal }}</strong>
                    <small>{{ abnormalContainerTotal ? "立即查看异常" : "暂无异常" }}</small>
                </router-link>
                <router-link to="/compose-management" class="metric-item">
                    <span>Compose</span>
                    <strong>{{ yamlTotal }}</strong>
                    <small>{{ discoveredYamlTotal }} 个外部项目</small>
                </router-link>
                <router-link to="/dockerbridge" class="metric-item">
                    <span>镜像</span>
                    <strong>{{ imageTotal }}</strong>
                    <small>本机镜像仓库</small>
                </router-link>
            </div>

            <div class="workspace-grid">
                <section class="workspace-panel compose-panel">
                    <div class="panel-heading">
                        <div>
                            <h2>Compose 工作区</h2>
                            <p>查看项目状态或继续编辑最近的配置。</p>
                        </div>
                        <router-link to="/compose-management" class="text-link">全部项目</router-link>
                    </div>

                    <div class="compose-stats">
                        <div>
                            <strong>{{ activeNum }}</strong>
                            <span>运行中</span>
                        </div>
                        <div>
                            <strong>{{ exitedNum }}</strong>
                            <span>已退出</span>
                        </div>
                        <div>
                            <strong>{{ inactiveNum }}</strong>
                            <span>未部署</span>
                        </div>
                    </div>

                    <div class="compose-actions">
                        <router-link to="/compose-management" class="action-link">
                            <span class="action-icon"><font-awesome-icon icon="stream" /></span>
                            <span><strong>管理 Compose</strong><small>扫描、筛选并打开项目</small></span>
                            <font-awesome-icon icon="chevron-circle-right" />
                        </router-link>
                        <router-link to="/compose" class="action-link">
                            <span class="action-icon"><font-awesome-icon icon="plus" /></span>
                            <span><strong>创建配置</strong><small>从模板开始新的服务栈</small></span>
                            <font-awesome-icon icon="chevron-circle-right" />
                        </router-link>
                    </div>
                </section>

                <section class="workspace-panel convert-panel">
                    <div class="panel-heading">
                        <div>
                            <h2>Docker Run 转换</h2>
                            <p>把一次性命令转换为可维护的 Compose 配置。</p>
                        </div>
                    </div>

                    <label class="visually-hidden" for="docker-run-command">Docker Run 命令</label>
                    <textarea id="docker-run-command" v-model="dockerRunCommand" class="form-control docker-run" required placeholder="docker run --name app -p 8080:80 nginx:latest"></textarea>
                    <div class="panel-actions">
                        <span>转换后可继续编辑端口、环境变量和数据卷。</span>
                        <button class="btn btn-primary" :disabled="!dockerRunCommand.trim()" @click="convertDockerRun">转换为 Compose</button>
                    </div>
                </section>

                <section class="workspace-panel agent-panel">
                    <div class="panel-heading">
                        <div>
                            <h2>远程节点 <span class="badge bg-warning">Beta</span></h2>
                            <p>管理当前连接的 DockerBridge 端点。</p>
                        </div>
                        <button v-if="!showAgentForm" class="btn btn-sm btn-normal" @click="showAgentForm = true">
                            <font-awesome-icon icon="plus" /> 添加节点
                        </button>
                    </div>

                    <div class="agent-list">
                        <div v-for="(agentItem, endpoint) in $root.agentList" :key="endpoint" class="agent-row">
                            <!-- Agent Status -->
                            <template v-if="$root.agentStatusList[endpoint]">
                                <span class="agent-state" :class="$root.agentStatusList[endpoint]" aria-hidden="true"></span>
                            </template>

                            <!-- Agent Display Name -->
                            <span class="agent-copy">
                                <strong v-if="endpoint === '' && agentItem.name === ''">当前节点</strong>
                                <strong v-else-if="agentItem.name === ''">{{ endpoint }}</strong>
                                <strong v-else>{{ agentItem.name }}</strong>
                                <small>{{ endpoint || "Local Docker runtime" }}</small>
                            </span>

                            <!-- Edit Name  -->
                            <button v-if="agentItem.name !== ''" class="icon-button" title="编辑节点名称" @click="showEditAgentNameDialog[agentItem.name] = !showEditAgentNameDialog[agentItem.Name]">
                                <font-awesome-icon icon="pen" />
                            </button>

                            <!-- Edit Dialog -->
                            <BModal v-model="showEditAgentNameDialog[agentItem.name]" :no-close-on-backdrop="true" :close-on-esc="true" :okTitle="$t('Update Name')" okVariant="info" @ok="updateName(agentItem.url, agentItem.updatedName)">
                                <label for="Update Name" class="form-label">Current value: {{ $t(agentItem.name) }}</label>
                                <input id="updatedName" v-model="agentItem.updatedName" type="text" class="form-control" optional>
                            </BModal>

                            <!-- Remove Button -->
                            <button v-if="endpoint !== ''" class="icon-button danger" title="移除节点" @click="showRemoveAgentDialog[agentItem.url] = !showRemoveAgentDialog[agentItem.url]">
                                <font-awesome-icon icon="trash" />
                            </button>

                            <!-- Remove Agent Dialog -->
                            <BModal v-model="showRemoveAgentDialog[agentItem.url]" :okTitle="$t('removeAgent')" okVariant="danger" @ok="removeAgent(agentItem.url)">
                                <p>{{ agentItem.url }}</p>
                                {{ $t("removeAgentMsg") }}
                            </BModal>
                        </div>
                        <div v-if="Object.keys($root.agentList).length === 0" class="empty-state">尚未连接远程节点。</div>
                    </div>

                    <!-- Add Agent Form -->
                    <form v-if="showAgentForm" class="agent-form" @submit.prevent="addAgent">
                        <div class="mb-3">
                            <label for="url" class="form-label">{{ $t("dockgeURL") }}</label>
                            <input id="url" v-model="agent.url" type="url" class="form-control" required placeholder="http://">
                        </div>

                        <div class="mb-3">
                            <label for="username" class="form-label">{{ $t("Username") }}</label>
                            <input id="username" v-model="agent.username" type="text" class="form-control" required>
                        </div>

                        <div class="mb-3">
                            <label for="password" class="form-label">{{ $t("Password") }}</label>
                            <input id="password" v-model="agent.password" type="password" class="form-control" required autocomplete="new-password">
                        </div>

                        <div class="mb-3">
                            <label for="name" class="form-label">{{ $t("Friendly Name") }}</label>
                            <input id="name" v-model="agent.name" type="text" class="form-control" optional>
                        </div>

                        <div class="form-actions">
                            <button type="button" class="btn btn-normal" @click="showAgentForm = false">取消</button>
                            <button type="submit" class="btn btn-primary" :disabled="connectingAgent">
                                <template v-if="connectingAgent">{{ $t("connecting") }}</template>
                                <template v-else>{{ $t("connect") }}</template>
                            </button>
                        </div>
                    </form>
                </section>
            </div>
        </div>
    </transition>
    <router-view ref="child" />
</template>

<script>
import { statusNameShort } from "../../../common/util-common";

export default {
    components: {

    },
    props: {
        calculatedHeight: {
            type: Number,
            default: 0
        }
    },
    data() {
        return {
            page: 1,
            perPage: 25,
            initialPerPage: 25,
            paginationConfig: {
                hideCount: true,
                chunksNavigation: "scroll",
            },
            importantHeartBeatListLength: 0,
            displayedRecords: [],
            runtimeSummary: {
                containerTotal: 0,
                running: 0,
                stopped: 0,
                abnormal: 0,
                restarting: 0,
                imageTotal: 0,
            },
            runtimeRefreshTimer: null,
            dockerRunCommand: "",
            showAgentForm: false,
            showRemoveAgentDialog: {},
            showEditAgentNameDialog: {},
            connectingAgent: false,
            agent: {
                url: "http://",
                username: "",
                password: "",
                name: "",
                updatedName: "",
            }
        };
    },

    computed: {
        stackList() {
            return Object.values(this.$root.completeStackList);
        },
        containerTotal() {
            return this.runtimeSummary.containerTotal || 0;
        },
        runningContainerTotal() {
            return this.runtimeSummary.running || 0;
        },
        abnormalContainerTotal() {
            return (this.runtimeSummary.abnormal || 0) + (this.runtimeSummary.restarting || 0);
        },
        runtimeHeadline() {
            if (this.abnormalContainerTotal > 0) {
                return `${this.abnormalContainerTotal} 个容器需要处理`;
            }
            if (this.containerTotal === 0) {
                return "等待部署第一个容器";
            }
            return "运行环境状态正常";
        },
        runtimeTone() {
            return this.abnormalContainerTotal > 0 ? "needs-attention" : "healthy";
        },
        cpuPercent() {
            return Math.max(0, Math.min(100, Math.round(Number(this.runtimeSummary.cpuPercent) || 0)));
        },
        memoryPercent() {
            return Math.max(0, Math.min(100, Math.round(Number(this.runtimeSummary.memoryPercent) || 0)));
        },
        imageTotal() {
            return this.runtimeSummary.imageTotal || 0;
        },
        yamlTotal() {
            return this.stackList.length;
        },
        discoveredYamlTotal() {
            return this.stackList.filter(stack => stack.isDiscoveredCompose).length;
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
    },

    watch: {
        perPage() {
            this.$nextTick(() => {
                this.getImportantHeartbeatListPaged();
            });
        },

        page() {
            this.getImportantHeartbeatListPaged();
        },
    },

    mounted() {
        this.initialPerPage = this.perPage;

        window.addEventListener("resize", this.updatePerPage);
        this.updatePerPage();
        this.loadRuntimeSummary();
        this.runtimeRefreshTimer = setInterval(this.loadRuntimeSummary, 10000);
    },

    beforeUnmount() {
        window.removeEventListener("resize", this.updatePerPage);
        clearInterval(this.runtimeRefreshTimer);
    },

    methods: {
        loadRuntimeSummary() {
            this.$root.getSocket().emit("getDockerBridgeSnapshot", (res) => {
                if (res.ok && res.summary) {
                    this.runtimeSummary = {
                        ...this.runtimeSummary,
                        ...res.summary,
                    };
                }
            });
        },

        addAgent() {
            this.connectingAgent = true;
            this.$root.getSocket().emit("addAgent", this.agent, (res) => {
                this.$root.toastRes(res);

                if (res.ok) {
                    this.showAgentForm = false;
                    this.agent = {
                        url: "http://",
                        username: "",
                        password: "",
                    };
                }

                this.connectingAgent = false;
            });
        },

        removeAgent(url) {
            this.$root.getSocket().emit("removeAgent", url, (res) => {
                if (res.ok) {
                    this.$root.toastRes(res);

                    let urlObj = new URL(url);
                    let endpoint = urlObj.host;

                    // Remove the stack list and status list of the removed agent
                    delete this.$root.allAgentStackList[endpoint];
                }
            });
        },

        updateName(url, updatedName) {
            this.$root.getSocket().emit("updateAgent", url, updatedName, (res) => {
                this.$root.toastRes(res);

                if (res.ok) {
                    this.showAgentForm = false;
                    this.agent = {
                        updatedName: "",
                    };
                }
            });
        },

        getStatusNum(statusName) {
            let num = 0;

            for (let stackName in this.$root.completeStackList) {
                const stack = this.$root.completeStackList[stackName];
                if (statusNameShort(stack.status) === statusName) {
                    num += 1;
                }
            }
            return num;
        },

        convertDockerRun() {
            if (!this.dockerRunCommand.trim() || this.dockerRunCommand.trim() === "docker run") {
                this.$root.toastError("请输入完整的 docker run 命令");
                return;
            }

            // composerize is working in dev, but after "vite build", it is not working
            // So pass to backend to do the conversion
            this.$root.getSocket().emit("composerize", this.dockerRunCommand, (res) => {
                if (res.ok) {
                    this.$root.composeTemplate = res.composeTemplate;
                    this.$router.push("/compose");
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Updates the displayed records when a new important heartbeat arrives.
         * @param {object} heartbeat - The heartbeat object received.
         * @returns {void}
         */
        onNewImportantHeartbeat(heartbeat) {
            if (this.page === 1) {
                this.displayedRecords.unshift(heartbeat);
                if (this.displayedRecords.length > this.perPage) {
                    this.displayedRecords.pop();
                }
                this.importantHeartBeatListLength += 1;
            }
        },

        /**
         * Retrieves the length of the important heartbeat list for all monitors.
         * @returns {void}
         */
        getImportantHeartbeatListLength() {
            this.$root.getSocket().emit("monitorImportantHeartbeatListCount", null, (res) => {
                if (res.ok) {
                    this.importantHeartBeatListLength = res.count;
                    this.getImportantHeartbeatListPaged();
                }
            });
        },

        /**
         * Retrieves the important heartbeat list for the current page.
         * @returns {void}
         */
        getImportantHeartbeatListPaged() {
            const offset = (this.page - 1) * this.perPage;
            this.$root.getSocket().emit("monitorImportantHeartbeatListPaged", null, offset, this.perPage, (res) => {
                if (res.ok) {
                    this.displayedRecords = res.data;
                }
            });
        },

        /**
         * Updates the number of items shown per page based on the available height.
         * @returns {void}
         */
        updatePerPage() {
            const tableContainer = this.$refs.tableContainer;
            const tableContainerHeight = tableContainer.offsetHeight;
            const availableHeight = window.innerHeight - tableContainerHeight;
            const additionalPerPage = Math.floor(availableHeight / 58);

            if (additionalPerPage > 0) {
                this.perPage = Math.max(this.initialPerPage, this.perPage + additionalPerPage);
            } else {
                this.perPage = this.initialPerPage;
            }

        },
    }
};
</script>

<style lang="scss" scoped>
@import "../styles/vars";

.dashboard-home {
    display: grid;
    gap: 16px;
}

.page-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;

    h1 {
        margin: 0;
    }

    p {
        margin: 6px 0 0;
        color: $muted-color;
    }
}

.page-actions,
.form-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
}

.runtime-overview {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr);
    gap: 28px;
    align-items: center;
    min-height: 174px;
    padding: 26px;
    border: 1px solid $border-color;
    border-radius: 14px;
    background: $surface;
    box-shadow: $soft-shadow;

    &.needs-attention {
        background: linear-gradient(110deg, $danger-surface 0, $surface 46%);

        .runtime-icon {
            color: $danger;
            background: rgba($danger, 0.1);
        }
    }

    .dark & {
        background: $dark-bg;
        border-color: $dark-border-color;
    }

    .dark &.needs-attention {
        background: linear-gradient(110deg, rgba($danger, 0.13), $dark-bg 48%);
    }
}

.runtime-summary {
    display: flex;
    align-items: center;
    gap: 18px;

    h2 {
        margin: 2px 0 6px;
        font-size: 25px;
    }

    p {
        margin: 0;
        color: $muted-color;
    }
}

.runtime-icon {
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    width: 54px;
    height: 54px;
    border-radius: 13px;
    background: $success-surface;
    color: $primary;
    font-size: 23px;
}

.runtime-kicker {
    color: $muted-color;
    font-size: 12px;
    font-weight: 750;
}

.resource-summary {
    display: grid;
    gap: 18px;
}

.resource-item {
    display: grid;
    gap: 7px;
}

.resource-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: $muted-color;
    font-size: 12px;

    strong {
        color: $text-color;
        font-size: 13px;

        .dark & {
            color: $dark-font-color2;
        }
    }
}

.resource-track {
    height: 7px;
    overflow: hidden;
    border-radius: 999px;
    background: $surface-subtle;

    span {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: $primary;
        transition: width 220ms ease-out;
    }

    .dark & {
        background: $dark-bg2;
    }
}

.metric-strip {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    overflow: hidden;
    border: 1px solid $border-color;
    border-radius: 12px;
    background: $surface;

    .dark & {
        background: $dark-bg;
        border-color: $dark-border-color;
    }
}

.metric-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2px 12px;
    min-width: 0;
    padding: 16px 18px;
    border-right: 1px solid $border-color;
    color: inherit;
    text-decoration: none;
    transition: background-color 160ms ease;

    &:last-child {
        border-right: 0;
    }

    &:hover {
        background: $surface-muted;
    }

    span,
    small {
        color: $muted-color;
    }

    strong {
        grid-row: 1 / span 2;
        grid-column: 2;
        align-self: center;
        font-size: 28px;
        line-height: 1;
    }

    small {
        overflow: hidden;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    &.alert strong {
        color: $danger;
    }

    .dark & {
        border-right-color: $dark-border-color;

        &:hover {
            background: $dark-bg2;
        }
    }
}

.workspace-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.12fr) minmax(340px, 0.88fr);
    grid-template-areas:
        "compose agents"
        "convert convert";
    gap: 16px;
}

.compose-panel {
    grid-area: compose;
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

.panel-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;

    h2 {
        margin: 0;
        font-size: 18px;
    }

    p {
        margin: 4px 0 0;
        color: $muted-color;
        font-size: 13px;
    }
}

.text-link {
    flex: 0 0 auto;
    color: $primary;
    font-size: 13px;
    font-weight: 700;
    text-decoration: none;
}

.compose-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin-bottom: 18px;
    padding: 16px 0;
    border-top: 1px solid $border-color;
    border-bottom: 1px solid $border-color;

    div {
        display: grid;
        gap: 2px;
        padding: 0 16px;
        border-right: 1px solid $border-color;

        &:first-child {
            padding-left: 0;
        }

        &:last-child {
            border-right: 0;
        }
    }

    strong {
        font-size: 24px;
    }

    span {
        color: $muted-color;
        font-size: 12px;
    }

    .dark &,
    .dark & div {
        border-color: $dark-border-color;
    }
}

.compose-actions {
    display: grid;
    gap: 8px;
}

.action-link {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    padding: 10px;
    border-radius: 9px;
    color: inherit;
    text-decoration: none;

    &:hover {
        background: $surface-muted;
    }

    strong,
    small {
        display: block;
    }

    small {
        margin-top: 1px;
        color: $muted-color;
        font-size: 11px;
    }

    > svg {
        color: $muted-color;
    }

    .dark &:hover {
        background: $dark-bg2;
    }
}

.action-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 9px;
    background: $highlight-white;
    color: $primary;

    .dark & {
        background: rgba($primary, 0.15);
    }
}

.convert-panel {
    grid-area: convert;
}

.docker-run {
    min-height: 128px;
    font-family: $mono-font;
    font-size: 13px;
    line-height: 1.6;
    background: #101714;
    color: #dce8e3;
    border-color: #293a34;

    &::placeholder {
        color: #95a39e;
    }
}

.panel-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 16px;
    margin-top: 14px;

    > span {
        margin-right: auto;
        color: $muted-color;
        font-size: 12px;
    }
}

.agent-panel {
    grid-area: agents;
    align-self: start;
}

.agent-list {
    display: grid;
    gap: 4px;
}

.agent-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 8px 4px;
    border-bottom: 1px solid $border-color;

    &:last-child {
        border-bottom: 0;
    }

    .dark & {
        border-color: $dark-border-color;
    }
}

.agent-state {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: $warning;

    &.online {
        background: $primary;
    }

    &.offline {
        background: $danger;
    }
}

.agent-copy {
    display: grid;
    flex: 1;
    min-width: 0;

    strong,
    small {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    small {
        color: $muted-color;
        font-size: 11px;
    }
}

.icon-button {
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    width: 34px;
    height: 34px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: $muted-color;

    &:hover {
        border-color: $border-color;
        background: $surface-muted;
        color: $text-color;
    }

    &.danger:hover {
        color: $danger;
        background: $danger-surface;
    }
}

.agent-form {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid $border-color;

    .form-actions {
        justify-content: flex-end;
    }

    .dark & {
        border-color: $dark-border-color;
    }
}

.empty-state {
    padding: 22px;
    color: $muted-color;
    text-align: center;
}

@media (max-width: 1100px) {
    .workspace-grid {
        grid-template-columns: 1fr;
        grid-template-areas:
            "compose"
            "convert"
            "agents";
    }
}

@media (max-width: 840px) {
    .runtime-overview {
        grid-template-columns: 1fr;
        gap: 22px;
    }

    .metric-strip {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .metric-item:nth-child(2) {
        border-right: 0;
    }

    .metric-item:nth-child(-n+2) {
        border-bottom: 1px solid $border-color;
    }
}

@media (max-width: 640px) {
    .page-heading {
        align-items: stretch;
        flex-direction: column;
    }

    .page-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;

        .btn {
            padding: 8px 10px;
        }
    }

    .runtime-overview {
        padding: 20px;
    }

    .runtime-summary {
        align-items: flex-start;
    }

    .runtime-icon {
        width: 44px;
        height: 44px;
        font-size: 18px;
    }

    .runtime-summary h2 {
        font-size: 21px;
    }

    .metric-strip {
        grid-template-columns: 1fr;
    }

    .metric-item,
    .metric-item:nth-child(2),
    .metric-item:nth-child(-n+2) {
        border-right: 0;
        border-bottom: 1px solid $border-color;
    }

    .metric-item:last-child {
        border-bottom: 0;
    }

    .workspace-panel {
        padding: 16px;
    }

    .panel-actions {
        align-items: stretch;
        flex-direction: column;
    }

    .panel-actions .btn {
        width: 100%;
    }
}

</style>
