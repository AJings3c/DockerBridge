<template>
    <div class="dockerbridge">
        <div class="page-heading">
            <div>
                <h1>容器与镜像</h1>
                <p>查看本机运行状态，并在一个工作区内完成日常 Docker 操作。</p>
            </div>
            <button class="btn btn-normal" :disabled="loading" @click="loadSnapshot">
                <font-awesome-icon :icon="loading ? 'spinner' : 'rotate'" :spin="loading" />
                {{ loading ? "刷新中" : "刷新状态" }}
            </button>
        </div>

        <div v-if="loading && !snapshot.generatedAt" class="loading-panel" aria-live="polite">
            <div class="skeleton-line wide"></div>
            <div class="skeleton-line"></div>
            <div class="skeleton-grid">
                <span v-for="index in 4" :key="index"></span>
            </div>
        </div>

        <div v-if="snapshot.errors.length > 0" class="runtime-alert" role="alert">
            <span class="alert-icon"><font-awesome-icon icon="exclamation-circle" /></span>
            <div>
                <strong>部分 Docker 数据暂时不可用</strong>
                <div v-for="error in snapshot.errors" :key="error">{{ error }}</div>
            </div>
        </div>

        <div v-if="snapshot.generatedAt" class="metric-grid">
            <button class="metric-card" @click="activeTab = 'containers'; statusFilter = 'running'">
                <span class="label">运行中</span>
                <span class="value running">{{ snapshot.summary.running }}</span>
            </button>
            <button class="metric-card" @click="activeTab = 'containers'; statusFilter = 'stopped'">
                <span class="label">已停止</span>
                <span class="value stopped">{{ snapshot.summary.stopped }}</span>
            </button>
            <button class="metric-card" @click="activeTab = 'containers'; statusFilter = 'abnormal'">
                <span class="label">异常</span>
                <span class="value abnormal">{{ snapshot.summary.abnormal }}</span>
            </button>
            <button class="metric-card" @click="activeTab = 'images'">
                <span class="label">镜像</span>
                <span class="value">{{ snapshot.summary.imageTotal }}</span>
            </button>
            <button class="metric-card" @click="activeTab = 'dashboard'">
                <span class="label">CPU</span>
                <span class="value">{{ snapshot.summary.cpuPercent }}%</span>
            </button>
            <button class="metric-card" @click="activeTab = 'dashboard'">
                <span class="label">Memory</span>
                <span class="value">{{ snapshot.summary.memoryPercent }}%</span>
            </button>
        </div>

        <div v-if="snapshot.generatedAt" class="shadow-box bridge-panel">
            <div class="tabs">
                <button class="tab" :class="{ active: activeTab === 'dashboard' }" @click="activeTab = 'dashboard'">
                    <font-awesome-icon icon="tachometer-alt" /> 运行概览
                </button>
                <button class="tab" :class="{ active: activeTab === 'containers' }" @click="activeTab = 'containers'">
                    <font-awesome-icon icon="list" /> 容器
                </button>
                <button v-if="selectedContainer" class="tab" :class="{ active: activeTab === 'containerDetail' }" @click="activeTab = 'containerDetail'">
                    <font-awesome-icon icon="info-circle" /> 容器详情
                </button>
                <button class="tab" :class="{ active: activeTab === 'images' }" @click="activeTab = 'images'">
                    <font-awesome-icon icon="images" /> 镜像
                </button>
                <button class="tab" :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'; loadDockerConfig()">
                    <font-awesome-icon icon="cog" /> Docker 设置
                </button>
                <button class="tab" :class="{ active: activeTab === 'logs' }" @click="activeTab = 'logs'; loadOperationLogs()">
                    <font-awesome-icon icon="stream" /> 操作日志
                </button>
            </div>

            <section v-if="activeTab === 'dashboard'" class="dashboard-grid">
                <div class="runtime-block">
                    <h2>运行环境</h2>
                    <div class="runtime-row">
                        <span>容器总数</span>
                        <strong>{{ snapshot.summary.containerTotal }}</strong>
                    </div>
                    <div class="runtime-row">
                        <span>主机内存</span>
                        <strong>{{ formatBytes(snapshot.summary.memoryUsed) }} / {{ formatBytes(snapshot.summary.memoryTotal) }}</strong>
                    </div>
                    <div class="runtime-row">
                        <span>最近刷新</span>
                        <strong>{{ lastRefreshed }}</strong>
                    </div>
                </div>

                <div class="runtime-block attention-block">
                    <h2>需要关注</h2>
                    <div v-if="abnormalContainers.length === 0" class="empty-state">
                        <font-awesome-icon icon="check-circle" /> 当前没有异常容器
                    </div>
                    <div v-for="container in abnormalContainers" :key="container.id" class="attention-row">
                        <span>{{ container.name }}</span>
                        <span class="badge bg-danger">{{ container.statusText }}</span>
                    </div>
                </div>

                <div class="runtime-block disk-block">
                    <h2>Docker 磁盘</h2>
                    <div v-if="snapshot.summary.disk.length === 0" class="empty-state">
                        暂无磁盘使用数据
                    </div>
                    <div v-for="item in snapshot.summary.disk" :key="item.Type" class="runtime-row">
                        <span>{{ item.Type }}</span>
                        <strong>{{ item.Size || "-" }}</strong>
                    </div>
                </div>
            </section>

            <section v-if="activeTab === 'containers'">
                <div class="table-tools">
                    <div class="search-wrapper">
                        <font-awesome-icon icon="search" />
                        <input v-model="containerSearch" class="form-control" aria-label="搜索容器" placeholder="搜索容器、Compose 或镜像" />
                    </div>
                    <select v-model="statusFilter" class="form-select status-select" aria-label="按状态筛选">
                        <option value="">全部状态</option>
                        <option value="running">运行中</option>
                        <option value="stopped">已停止</option>
                        <option value="abnormal">异常</option>
                        <option value="restarting">重启中</option>
                    </select>
                    <select v-model="stackFilter" class="form-select status-select" aria-label="按 Compose 筛选">
                        <option value="">全部 Compose</option>
                        <option v-for="stack in stackOptions" :key="stack" :value="stack">{{ stack }}</option>
                    </select>
                    <select v-model="containerImageFilter" class="form-select image-filter" aria-label="按镜像筛选">
                        <option value="">全部镜像</option>
                        <option v-for="image in containerImageOptions" :key="image" :value="image">{{ image }}</option>
                    </select>
                </div>

                <div class="table-responsive container-table">
                    <table class="table align-middle">
                        <thead>
                            <tr>
                                <th>名称</th>
                                <th>Compose</th>
                                <th>状态</th>
                                <th>镜像</th>
                                <th>端口</th>
                                <th>CPU</th>
                                <th>内存</th>
                                <th>卷</th>
                                <th>缓存</th>
                                <th>创建时间</th>
                                <th>启动时间</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="container in filteredContainers" :key="container.id" :class="`container-${container.status}`">
                                <td>
                                    <button class="link-button" @click="showContainerDetail(container)">
                                        <strong>{{ container.name }}</strong>
                                    </button>
                                    <div class="muted-mono">{{ container.shortId }}</div>
                                </td>
                                <td>
                                    {{ container.managedBy === 'compose' ? container.stack : '独立容器' }}
                                    <div class="text-muted small">{{ container.service }}</div>
                                </td>
                                <td>
                                    <span class="badge" :class="statusClass(container.status)">{{ container.statusText }}</span>
                                </td>
                                <td>
                                    {{ container.image }}
                                    <div class="text-muted small">tag {{ container.imageTag }}</div>
                                </td>
                                <td>
                                    <div v-if="container.ports.length === 0" class="text-muted">-</div>
                                    <div v-for="port in container.ports" :key="`${container.id}-${port.containerPort}-${port.hostPort}`" class="port-line">
                                        <strong v-if="port.published">{{ port.hostPort }}</strong>
                                        <span v-else class="text-muted">未发布</span>
                                        <span class="text-muted"> : {{ port.containerPort }}/{{ port.protocol }}</span>
                                        <button
                                            v-if="port.published"
                                            class="btn btn-link btn-sm port-edit"
                                            :disabled="!container.canEditPorts || actionLoading"
                                            title="Edit host port"
                                            @click="editPort(container, port)"
                                        >
                                            <font-awesome-icon icon="edit" />
                                        </button>
                                    </div>
                                </td>
                                <td>{{ container.cpuPercent }}</td>
                                <td>
                                    {{ container.memoryUsage }}
                                    <div class="text-muted small">{{ container.memoryPercent }}</div>
                                </td>
                                <td>{{ container.volumeCount }}</td>
                                <td>{{ container.cacheState === 'configured' ? '已配置' : '未配置' }}</td>
                                <td>{{ formatTime(container.createdAt) }}</td>
                                <td>{{ formatTime(container.startedAt) }}</td>
                                <td>
                                    <div class="action-row">
                                        <button v-if="container.status !== 'running'" class="btn btn-sm btn-normal" :disabled="actionLoading" @click="containerAction(container, 'start')">
                                            <font-awesome-icon icon="play" />
                                        </button>
                                        <button v-if="container.status === 'running'" class="btn btn-sm btn-normal" :disabled="actionLoading" @click="containerAction(container, 'stop')">
                                            <font-awesome-icon icon="stop" />
                                        </button>
                                        <button class="btn btn-sm btn-normal" :disabled="actionLoading" @click="containerAction(container, 'restart')">
                                            <font-awesome-icon icon="rotate" />
                                        </button>
                                        <button class="btn btn-sm btn-normal" :disabled="actionLoading" title="Force recreate" @click="containerAction(container, 'recreate')">
                                            <font-awesome-icon icon="clone" />
                                        </button>
                                        <button class="btn btn-sm btn-normal" :disabled="actionLoading" @click="viewLogs(container)">
                                            <font-awesome-icon icon="file" />
                                        </button>
                                    </div>
                                </td>
                            </tr>
                            <tr v-if="filteredContainers.length === 0">
                                <td colspan="12" class="empty-row">没有符合当前筛选条件的容器。</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            <section v-if="activeTab === 'containerDetail' && selectedContainer">
                <div class="detail-heading">
                    <div>
                        <h2>{{ selectedContainer.name }}</h2>
                        <div class="muted-mono">{{ selectedContainer.id }}</div>
                    </div>
                    <div class="button-row">
                        <button class="btn btn-normal" :disabled="actionLoading" @click="viewLogs(selectedContainer)">
                            <font-awesome-icon icon="file" /> Logs
                        </button>
                        <button class="btn btn-normal" :disabled="actionLoading" @click="containerAction(selectedContainer, 'recreate')">
                            <font-awesome-icon icon="clone" /> Recreate
                        </button>
                    </div>
                </div>

                <div class="detail-grid">
                    <div class="detail-block">
                        <h2>Basic</h2>
                        <div class="runtime-row"><span>Status</span><strong>{{ selectedContainer.statusText }}</strong></div>
                        <div class="runtime-row"><span>Managed by</span><strong>{{ selectedContainer.managedBy === 'compose' ? 'Compose' : 'Standalone container' }}</strong></div>
                        <div class="runtime-row"><span>Stack</span><strong>{{ selectedContainer.stack }}</strong></div>
                        <div class="runtime-row"><span>Service</span><strong>{{ selectedContainer.service }}</strong></div>
                        <div class="runtime-row"><span>Created</span><strong>{{ formatTime(selectedContainer.createdAt) }}</strong></div>
                        <div class="runtime-row"><span>Started</span><strong>{{ formatTime(selectedContainer.startedAt) }}</strong></div>
                    </div>

                    <div class="detail-block">
                        <h2>Image</h2>
                        <div class="runtime-row"><span>Image</span><strong>{{ selectedContainer.image }}</strong></div>
                        <div class="runtime-row"><span>Tag</span><strong>{{ selectedContainer.imageTag }}</strong></div>
                        <div class="runtime-row"><span>Image ID</span><strong class="muted-mono">{{ shortText(selectedContainer.imageId) }}</strong></div>
                    </div>

                    <div class="detail-block">
                        <h2>Resource</h2>
                        <div class="runtime-row"><span>CPU</span><strong>{{ selectedContainer.cpuPercent }}</strong></div>
                        <div class="runtime-row"><span>Memory</span><strong>{{ selectedContainer.memoryUsage }} / {{ selectedContainer.memoryPercent }}</strong></div>
                        <div class="runtime-row"><span>Network I/O</span><strong>{{ selectedContainer.networkIO }}</strong></div>
                        <div class="runtime-row"><span>Block I/O</span><strong>{{ selectedContainer.blockIO }}</strong></div>
                    </div>

                    <div class="detail-block">
                        <h2>Ports</h2>
                        <div v-if="selectedContainer.ports.length === 0" class="empty-state">No ports.</div>
                        <div v-for="port in selectedContainer.ports" :key="`${selectedContainer.id}-detail-${port.containerPort}-${port.hostPort}`" class="runtime-row">
                            <span>{{ port.containerPort }}/{{ port.protocol }}</span>
                            <strong>{{ port.published ? port.hostPort : 'unpublished' }}</strong>
                        </div>
                    </div>

                    <div class="detail-block">
                        <h2>Data Volumes</h2>
                        <div v-if="selectedContainer.mounts.length === 0" class="empty-state">No mounts.</div>
                        <div v-for="mount in selectedContainer.mounts" :key="`${selectedContainer.id}-${mount.destination}`" class="mount-row">
                            <div>
                                <strong>{{ mount.destination }}</strong>
                                <div class="muted-mono">{{ mount.source || mount.name || '-' }}</div>
                            </div>
                            <span class="badge" :class="mount.cache ? 'bg-warning' : 'bg-secondary'">{{ mount.cache ? 'cache' : mount.type }}</span>
                        </div>
                    </div>

                    <div class="detail-block">
                        <h2>Cache Directories</h2>
                        <div v-if="selectedContainer.cacheDirs.length === 0" class="empty-state">No declared cache directories.</div>
                        <div v-for="cacheDir in selectedContainer.cacheDirs" :key="`${selectedContainer.id}-${cacheDir}`" class="runtime-row">
                            <span>{{ cacheDir }}</span>
                            <strong>declared</strong>
                        </div>
                    </div>
                </div>
            </section>

            <section v-if="activeTab === 'images'">
                <div class="table-tools">
                    <div class="search-wrapper image-search">
                        <font-awesome-icon icon="search" />
                        <input v-model="imageSearch" class="form-control" placeholder="Search images and tags" />
                    </div>
                    <button class="btn btn-primary" :disabled="actionLoading" @click="pullImage">
                        <font-awesome-icon icon="cloud-arrow-down" /> Pull image
                    </button>
                </div>

                <div class="table-responsive">
                    <table class="table align-middle">
                        <thead>
                            <tr>
                                <th>Image</th>
                                <th>ID</th>
                                <th>Size</th>
                                <th>Created</th>
                                <th>Last pulled</th>
                                <th>Exposed ports</th>
                                <th>Used by</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="image in filteredImages" :key="`${image.repository}:${image.tag}:${image.id}`">
                                <td>
                                    <strong>{{ image.repository }}</strong>
                                    <div class="text-muted small">{{ image.tag }}</div>
                                </td>
                                <td class="muted-mono">{{ image.id }}</td>
                                <td>{{ image.size }}</td>
                                <td>{{ image.createdAt || "-" }}</td>
                                <td>{{ formatTime(image.recentPulledAt) }}</td>
                                <td>{{ image.exposedPorts.length ? image.exposedPorts.join(", ") : "-" }}</td>
                                <td>
                                    <span v-if="image.usedBy.length === 0" class="text-muted">Unused</span>
                                    <span v-for="name in image.usedBy" v-else :key="`${image.id}-${name}`" class="used-by">{{ name }}</span>
                                </td>
                                <td>
                                    <button class="btn btn-sm btn-normal" :disabled="image.usedBy.length > 0 || actionLoading" @click="deleteImage(image)">
                                        <font-awesome-icon icon="trash" />
                                    </button>
                                </td>
                            </tr>
                            <tr v-if="filteredImages.length === 0">
                                <td colspan="8" class="empty-row">No images match the current filters.</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            <section v-if="activeTab === 'settings'">
                <div class="alert alert-warning">
                    Saving Docker daemon configuration creates a backup first. Restarting Docker may interrupt all running containers and can temporarily disconnect DockerBridge.
                </div>
                <div v-if="!dockerConfig.editable" class="alert alert-secondary">
                    Docker daemon config editing is disabled. {{ dockerConfig.reason }}
                </div>

                <div class="settings-grid">
                    <label>
                        Registry mirrors
                        <textarea class="form-control" :disabled="!dockerConfig.editable" :value="arrayToText(dockerConfig.form.registryMirrors)" rows="3" @input="setArrayField('registryMirrors', $event.target.value)"></textarea>
                    </label>
                    <label>
                        DNS
                        <textarea class="form-control" :disabled="!dockerConfig.editable" :value="arrayToText(dockerConfig.form.dns)" rows="3" @input="setArrayField('dns', $event.target.value)"></textarea>
                    </label>
                    <label>
                        Insecure registries
                        <textarea class="form-control" :disabled="!dockerConfig.editable" :value="arrayToText(dockerConfig.form.insecureRegistries)" rows="3" @input="setArrayField('insecureRegistries', $event.target.value)"></textarea>
                    </label>
                    <label>
                        HTTP proxy
                        <input v-model="dockerConfig.form.httpProxy" class="form-control" :disabled="!dockerConfig.editable" />
                    </label>
                    <label>
                        HTTPS proxy
                        <input v-model="dockerConfig.form.httpsProxy" class="form-control" :disabled="!dockerConfig.editable" />
                    </label>
                    <label>
                        No proxy
                        <input v-model="dockerConfig.form.noProxy" class="form-control" :disabled="!dockerConfig.editable" />
                    </label>
                    <label>
                        Log driver
                        <input v-model="dockerConfig.form.logDriver" class="form-control" placeholder="json-file" :disabled="!dockerConfig.editable" />
                    </label>
                    <label>
                        Log max size
                        <input v-model="dockerConfig.form.logMaxSize" class="form-control" placeholder="10m" :disabled="!dockerConfig.editable" />
                    </label>
                    <label>
                        Log max file
                        <input v-model="dockerConfig.form.logMaxFile" class="form-control" placeholder="3" :disabled="!dockerConfig.editable" />
                    </label>
                </div>

                <div class="setting-meta">
                    <div><strong>Config path:</strong> {{ dockerConfig.configPath }}</div>
                    <div><strong>Restart command:</strong> {{ dockerConfig.restartCommand }}</div>
                    <div><strong>Editable:</strong> {{ dockerConfig.editable ? "Yes" : "No" }}</div>
                </div>

                <div class="button-row">
                    <button class="btn btn-primary" :disabled="actionLoading || !dockerConfig.editable" @click="saveDockerConfig">
                        <font-awesome-icon icon="save" /> Save config
                    </button>
                    <button class="btn btn-warning" :disabled="actionLoading || !dockerConfig.editable" @click="restartDockerDaemon">
                        <font-awesome-icon icon="rotate" /> Restart Docker
                    </button>
                </div>

                <h2 class="mt-4">Backups</h2>
                <div v-if="dockerConfig.backups.length === 0" class="empty-state">No backups yet.</div>
                <div v-for="backup in dockerConfig.backups" :key="backup.file" class="backup-row">
                    <span>{{ backup.filename }}</span>
                    <button class="btn btn-sm btn-normal" :disabled="actionLoading || !dockerConfig.editable" @click="rollbackDockerConfig(backup.file)">
                        <font-awesome-icon icon="undo" /> Rollback
                    </button>
                </div>
            </section>

            <section v-if="activeTab === 'logs'">
                <div class="button-row">
                    <button class="btn btn-normal" @click="loadOperationLogs">
                        <font-awesome-icon icon="rotate" /> Refresh logs
                    </button>
                </div>

                <div class="table-responsive">
                    <table class="table align-middle">
                        <thead>
                            <tr>
                                <th>Time</th>
                                <th>Action</th>
                                <th>Object</th>
                                <th>Result</th>
                                <th>Error</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="log in operationLogs" :key="log.id">
                                <td>{{ formatTime(log.time) }}</td>
                                <td>{{ log.action_type }}</td>
                                <td>
                                    {{ log.object_type }}
                                    <div class="muted-mono">{{ log.object_id }}</div>
                                </td>
                                <td>
                                    <span class="badge" :class="log.result === 'success' ? 'bg-primary' : 'bg-danger'">{{ log.result }}</span>
                                </td>
                                <td>{{ log.error || "-" }}</td>
                            </tr>
                            <tr v-if="operationLogs.length === 0">
                                <td colspan="5" class="empty-row">No operation logs yet.</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>
        </div>

        <div v-if="logViewer.show" class="log-modal">
            <div class="log-dialog">
                <div class="log-header">
                    <strong>{{ logViewer.title }}</strong>
                    <div class="log-actions">
                        <select v-model.number="logViewer.tail" class="form-select form-select-sm" :disabled="actionLoading" @change="reloadContainerLogs">
                            <option :value="100">Last 100</option>
                            <option :value="300">Last 300</option>
                            <option :value="1000">Last 1000</option>
                            <option :value="5000">Last 5000</option>
                        </select>
                        <button class="btn btn-sm btn-normal" :disabled="actionLoading" @click="reloadContainerLogs">
                            <font-awesome-icon icon="rotate" />
                        </button>
                        <button class="btn btn-sm btn-normal" @click="logViewer.show = false">
                            <font-awesome-icon icon="times" />
                        </button>
                    </div>
                </div>
                <pre>{{ logViewer.content }}</pre>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    data() {
        return {
            loading: false,
            activeTab: "dashboard",
            statusFilter: "",
            stackFilter: "",
            containerImageFilter: "",
            containerSearch: "",
            imageSearch: "",
            selectedContainerId: "",
            actionLoading: false,
            refreshTimer: null,
            lastPortRollback: null,
            logViewer: {
                show: false,
                title: "",
                content: "",
                containerId: "",
                tail: 300,
            },
            operationLogs: [],
            dockerConfig: {
                configPath: "",
                restartCommand: "",
                editable: false,
                reason: "",
                form: {
                    registryMirrors: [],
                    httpProxy: "",
                    httpsProxy: "",
                    noProxy: "",
                    dns: [],
                    insecureRegistries: [],
                    logDriver: "",
                    logMaxSize: "",
                    logMaxFile: "",
                },
                backups: [],
            },
            snapshot: {
                dockerAvailable: true,
                generatedAt: "",
                summary: {
                    cpuPercent: 0,
                    memoryTotal: 0,
                    memoryUsed: 0,
                    memoryPercent: 0,
                    containerTotal: 0,
                    running: 0,
                    stopped: 0,
                    abnormal: 0,
                    restarting: 0,
                    imageTotal: 0,
                    disk: [],
                },
                containers: [],
                images: [],
                errors: [],
            },
        };
    },

    computed: {
        filteredContainers() {
            const search = this.containerSearch.trim().toLowerCase();
            return this.snapshot.containers.filter((container) => {
                const statusMatch = !this.statusFilter || container.status === this.statusFilter;
                const stackMatch = !this.stackFilter || container.stack === this.stackFilter;
                const imageMatch = !this.containerImageFilter || container.image === this.containerImageFilter;
                const searchMatch = !search
                    || container.name.toLowerCase().includes(search)
                    || container.stack.toLowerCase().includes(search)
                    || container.service.toLowerCase().includes(search)
                    || container.image.toLowerCase().includes(search);
                return statusMatch && stackMatch && imageMatch && searchMatch;
            });
        },

        selectedContainer() {
            return this.snapshot.containers.find(container => container.id === this.selectedContainerId);
        },

        stackOptions() {
            return [ ...new Set(this.snapshot.containers.map(container => container.stack).filter(stack => stack && stack !== "-")) ].sort();
        },

        containerImageOptions() {
            return [ ...new Set(this.snapshot.containers.map(container => container.image).filter(Boolean)) ].sort();
        },

        filteredImages() {
            const search = this.imageSearch.trim().toLowerCase();
            return this.snapshot.images.filter((image) => {
                return !search
                    || image.repository.toLowerCase().includes(search)
                    || image.tag.toLowerCase().includes(search)
                    || image.id.toLowerCase().includes(search);
            });
        },

        abnormalContainers() {
            return this.snapshot.containers.filter(container => container.status === "abnormal" || container.status === "restarting");
        },

        lastRefreshed() {
            if (!this.snapshot.generatedAt) {
                return "-";
            }
            return new Date(this.snapshot.generatedAt).toLocaleTimeString();
        },
    },

    mounted() {
        this.loadSnapshot();
        this.refreshTimer = setInterval(this.loadSnapshot, 10000);
    },

    beforeUnmount() {
        clearInterval(this.refreshTimer);
    },

    methods: {
        loadSnapshot() {
            if (this.loading) {
                return;
            }

            this.loading = true;
            this.$root.getSocket().emit("getDockerBridgeSnapshot", (res) => {
                if (res.ok) {
                    this.snapshot = res;
                } else {
                    this.$root.toastRes(res);
                }
                this.loading = false;
            });
        },

        containerAction(container, action) {
            let message = `${action} ${container.name}?`;
            if (action === "recreate") {
                message = `Recreate ${container.name} now?\n\nThe container will be stopped and removed, volumes will be preserved, and only explicitly declared cache directories will be cleaned.`;
            } else if (action === "restart") {
                message = `Restart ${container.name}? The service may be briefly unavailable.`;
            } else if (action === "stop") {
                message = `Stop ${container.name}?`;
            }

            if ([ "stop", "restart", "recreate" ].includes(action) && !confirm(message)) {
                return;
            }

            this.actionLoading = true;
            this.$root.getSocket().emit("dockerBridgeContainerAction", container.id, action, (res) => {
                this.actionLoading = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.loadSnapshot();
                    this.loadOperationLogs();
                }
            });
        },

        showContainerDetail(container) {
            this.selectedContainerId = container.id;
            this.activeTab = "containerDetail";
        },

        editPort(container, port) {
            if (!container.canEditPorts) {
                this.$root.toastError("This container does not have a published host port to edit");
                return;
            }

            const nextPort = prompt(`Host port for ${container.name} ${port.containerPort}/${port.protocol}`, port.hostPort);
            if (!nextPort || nextPort === port.hostPort) {
                return;
            }

            if (!confirm(`Change ${container.name} host port from ${port.hostPort} to ${nextPort} and recreate the container now?\n\nDockerBridge will preserve volumes and only clean cache directories explicitly declared for this container.`)) {
                return;
            }

            this.actionLoading = true;
            this.$root.getSocket().emit("updateDockerBridgeHostPort", {
                containerId: container.id,
                containerPort: port.containerPort,
                protocol: port.protocol,
                hostPort: nextPort,
                currentHostPort: port.hostPort,
                hostIp: port.hostIp,
            }, (res) => {
                this.actionLoading = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.lastPortRollback = res.rollback;
                    this.loadSnapshot();
                    this.loadOperationLogs();
                } else if (res.rollback && confirm("Container recreate failed. Roll back to the previous port configuration now?")) {
                    this.rollbackPortChange(res.rollback);
                }
            });
        },

        rollbackPortChange(rollback) {
            this.actionLoading = true;
            this.$root.getSocket().emit("rollbackDockerBridgeHostPort", rollback, (res) => {
                this.actionLoading = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.loadSnapshot();
                    this.loadOperationLogs();
                }
            });
        },

        viewLogs(container, tail = this.logViewer.tail || 300) {
            this.actionLoading = true;
            this.$root.getSocket().emit("getDockerBridgeContainerLogs", container.id, {
                tail,
            }, (res) => {
                this.actionLoading = false;
                if (res.ok) {
                    this.logViewer = {
                        show: true,
                        title: `${container.name} logs`,
                        content: res.logs || "",
                        containerId: container.id,
                        tail: res.tail || tail,
                    };
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        reloadContainerLogs() {
            const container = this.snapshot.containers.find(item => item.id === this.logViewer.containerId);
            if (!container) {
                this.$root.toastError("Container is no longer available");
                return;
            }

            this.viewLogs(container, this.logViewer.tail);
        },

        pullImage() {
            const imageRef = prompt("Image to pull, for example nginx:latest");
            if (!imageRef) {
                return;
            }

            this.actionLoading = true;
            this.$root.getSocket().emit("pullDockerBridgeImage", imageRef, (res) => {
                this.actionLoading = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.loadSnapshot();
                    this.loadOperationLogs();
                }
            });
        },

        deleteImage(image) {
            if (image.usedBy.length > 0) {
                this.$root.toastError("Only unused images can be deleted");
                return;
            }

            if (!confirm(`Delete unused image ${image.repository}:${image.tag}?`)) {
                return;
            }

            this.actionLoading = true;
            this.$root.getSocket().emit("deleteDockerBridgeImage", image.id, (res) => {
                this.actionLoading = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.loadSnapshot();
                    this.loadOperationLogs();
                }
            });
        },

        loadDockerConfig() {
            this.$root.getSocket().emit("getDockerBridgeDockerConfig", (res) => {
                if (res.ok) {
                    this.dockerConfig = res;
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        saveDockerConfig() {
            if (!this.dockerConfig.editable) {
                this.$root.toastError(this.dockerConfig.reason || "Docker daemon config editing is disabled");
                return;
            }

            if (!confirm("Save Docker daemon configuration? A backup will be created first.")) {
                return;
            }

            this.actionLoading = true;
            this.$root.getSocket().emit("saveDockerBridgeDockerConfig", this.dockerConfig.form, (res) => {
                this.actionLoading = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.dockerConfig.form = res.form;
                    this.dockerConfig.backups = res.backups;
                    this.loadOperationLogs();
                }
            });
        },

        restartDockerDaemon() {
            if (!this.dockerConfig.editable) {
                this.$root.toastError(this.dockerConfig.reason || "Docker daemon config editing is disabled");
                return;
            }

            if (!confirm("Restart Docker service now? Running containers may be interrupted and DockerBridge may become temporarily unavailable.")) {
                return;
            }

            this.actionLoading = true;
            this.$root.getSocket().emit("restartDockerBridgeDockerDaemon", (res) => {
                this.actionLoading = false;
                this.$root.toastRes(res);
                this.loadOperationLogs();
                this.loadSnapshot();
            });
        },

        rollbackDockerConfig(backupFile) {
            if (!this.dockerConfig.editable) {
                this.$root.toastError(this.dockerConfig.reason || "Docker daemon config editing is disabled");
                return;
            }

            if (!confirm(`Rollback Docker config from ${backupFile}? Docker restart is still required after rollback.`)) {
                return;
            }

            this.actionLoading = true;
            this.$root.getSocket().emit("rollbackDockerBridgeDockerConfig", backupFile, (res) => {
                this.actionLoading = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.dockerConfig.form = res.form;
                    this.dockerConfig.backups = res.backups;
                    this.loadOperationLogs();
                }
            });
        },

        loadOperationLogs() {
            this.$root.getSocket().emit("getDockerBridgeOperationLogs", (res) => {
                if (res.ok) {
                    this.operationLogs = res.logs;
                }
            });
        },

        setArrayField(field, value) {
            this.dockerConfig.form[field] = value.split("\n")
                .map(item => item.trim())
                .filter(Boolean);
        },

        arrayToText(value) {
            return Array.isArray(value) ? value.join("\n") : "";
        },

        formatTime(value) {
            if (!value) {
                return "-";
            }
            return new Date(value).toLocaleString();
        },

        shortText(value) {
            if (!value) {
                return "-";
            }
            return value.replace(/^sha256:/, "").slice(0, 18);
        },

        statusClass(status) {
            return {
                running: "bg-primary",
                stopped: "bg-secondary",
                abnormal: "bg-danger",
                restarting: "bg-warning",
            }[status] || "bg-secondary";
        },

        formatBytes(value) {
            if (!value) {
                return "0 B";
            }

            const units = [ "B", "KB", "MB", "GB", "TB" ];
            let size = value;
            let unitIndex = 0;

            while (size >= 1024 && unitIndex < units.length - 1) {
                size /= 1024;
                unitIndex += 1;
            }

            return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/vars";

.dockerbridge {
    display: grid;
    gap: 16px;

    h1 {
        margin: 0;
    }

    h2 {
        font-size: 18px;
        margin-bottom: 14px;
    }
}

.page-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;

    p {
        margin: 5px 0 0;
        color: $muted-color;
    }
}

.metric-grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    overflow: hidden;
    border: 1px solid $border-color;
    border-radius: 12px;
    background: $surface;

    .dark & {
        background: $dark-bg;
        border-color: $dark-border-color;
    }
}

.metric-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    min-height: 78px;
    padding: 14px 16px;
    border: 0;
    border-right: 1px solid $border-color;
    background: transparent;
    text-align: left;
    transition: background-color 160ms ease;

    &:last-child {
        border-right: 0;
    }

    &:hover {
        background: $surface-muted;
    }

    .dark & {
        background: transparent;
        border-color: $dark-border-color;
        color: $dark-font-color;

        &:hover {
            background: $dark-bg2;
        }
    }
}

.label {
    color: $muted-color;
    display: block;
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0;

    .dark & {
        color: $dark-font-color;
    }
}

.value {
    color: $text-color;
    display: block;
    font-size: 25px;
    font-weight: 700;
    line-height: 1;

    &.running {
        color: $primary;
    }

    &.stopped {
        color: #6c757d;
    }

    &.abnormal {
        color: $danger;
    }

    .dark & {
        color: #e6edf3;
    }
}

.bridge-panel {
    padding: 0;
    overflow: hidden;
}

.loading-panel {
    display: grid;
    gap: 12px;
    padding: 24px;
    border: 1px solid $border-color;
    border-radius: 12px;
    background: $surface;

    .dark & {
        background: $dark-bg;
        border-color: $dark-border-color;
    }
}

.skeleton-line,
.skeleton-grid span {
    background: linear-gradient(90deg, $surface-subtle 25%, $surface-muted 50%, $surface-subtle 75%);
    background-size: 200% 100%;
    animation: skeleton-shift 1.3s ease-in-out infinite;
}

.skeleton-line {
    width: 38%;
    height: 12px;
    border-radius: 5px;

    &.wide {
        width: 64%;
        height: 22px;
    }
}

.skeleton-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-top: 8px;

    span {
        height: 72px;
        border-radius: 9px;
    }
}

@keyframes skeleton-shift {
    to {
        background-position: -200% 0;
    }
}

.runtime-alert {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 16px;
    border: 1px solid rgba($warning, 0.32);
    border-radius: 10px;
    background: $warning-surface;
    color: #513816;

    strong {
        display: block;
        margin-bottom: 3px;
    }

    .alert-icon {
        color: $warning;
        font-size: 18px;
    }
}

.tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid $border-color;
    padding: 8px 10px;
    overflow-x: auto;

    .dark & {
        border-color: $dark-border-color;
    }
}

.tab {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    color: $muted-color;
    padding: 9px 11px;
    white-space: nowrap;

    &.active {
        border-color: rgba($primary, 0.2);
        background: $highlight-white;
        color: #155e55;
        font-weight: 700;
    }

    .dark & {
        color: $dark-font-color;
    }
}

section {
    padding: 18px;
}

.dashboard-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
}

.runtime-block {
    min-width: 0;
    padding: 16px;
    border: 1px solid $border-color;
    border-radius: 10px;

    &.disk-block {
        grid-column: 1 / -1;
    }

    .dark & {
        border-color: $dark-border-color;
    }
}

.runtime-row,
.attention-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid $border-color;
    min-height: 42px;

    .dark & {
        border-color: $dark-border-color;
    }
}

.table-tools {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
    padding: 10px;
    border: 1px solid $border-color;
    border-radius: 8px;
    background: $surface-muted;

    .dark & {
        background: $dark-bg2;
        border-color: $dark-border-color;
    }
}

.search-wrapper {
    align-items: center;
    display: flex;
    flex: 1;
    gap: 8px;
    max-width: 520px;

    > svg {
        margin-left: 5px;
        color: $muted-color;
    }
}

.status-select {
    max-width: 180px;
}

.image-filter {
    max-width: 260px;
}

.image-search {
    max-width: 420px;
}

.muted-mono {
    color: $muted-color;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
}

.port-line {
    white-space: nowrap;
}

.used-by {
    background: #edf7ff;
    border-radius: 6px;
    color: #1e5b86;
    display: inline-block;
    font-size: 12px;
    margin: 2px 4px 2px 0;
    padding: 2px 6px;

    .dark & {
        background: #10243a;
        color: #9dd1ff;
    }
}

.link-button {
    background: transparent;
    border: 0;
    color: inherit;
    padding: 0;
    text-align: left;

    &:hover {
        color: $primary;
    }
}

.action-row,
.button-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
}

.port-edit {
    margin-left: 4px;
    padding: 0 4px;
}

.detail-heading {
    align-items: flex-start;
    display: flex;
    gap: 16px;
    justify-content: space-between;
    margin-bottom: 18px;
}

.detail-grid {
    display: grid;
    gap: 16px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
}

.detail-block {
    border: 1px solid $border-color;
    border-radius: 8px;
    padding: 14px;

    .dark & {
        border-color: $dark-border-color;
    }
}

.mount-row {
    align-items: center;
    border-bottom: 1px solid $border-color;
    display: flex;
    gap: 12px;
    justify-content: space-between;
    min-height: 52px;

    .dark & {
        border-color: $dark-border-color;
    }
}

.settings-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;

    label {
        color: $muted-color;
        font-size: 13px;
        font-weight: 700;

        .form-control {
            font-weight: 400;
            margin-top: 6px;
        }

        .dark & {
            color: $dark-font-color;
        }
    }
}

.setting-meta {
    border-top: 1px solid $border-color;
    color: $muted-color;
    font-size: 13px;
    margin: 18px 0;
    padding-top: 14px;

    .dark & {
        border-color: $dark-border-color;
        color: $dark-font-color;
    }
}

.backup-row {
    align-items: center;
    border-bottom: 1px solid $border-color;
    display: flex;
    justify-content: space-between;
    min-height: 44px;

    .dark & {
        border-color: $dark-border-color;
    }
}

.log-modal {
    align-items: center;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    inset: 0;
    justify-content: center;
    position: fixed;
    z-index: 2000;
}

.log-dialog {
    background: #fff;
    border-radius: 8px;
    border: 1px solid $border-color;
    box-shadow: $soft-shadow;
    max-height: 82vh;
    max-width: 980px;
    overflow: hidden;
    width: 92vw;

    .dark & {
        background: $dark-bg;
    }

    pre {
        background: #0d1117;
        color: #d9e2ec;
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        margin: 0;
        max-height: 70vh;
        overflow: auto;
        padding: 14px;
        white-space: pre-wrap;
    }
}

.log-header {
    align-items: center;
    display: flex;
    gap: 12px;
    justify-content: space-between;
    padding: 12px 14px;
}

.log-actions {
    align-items: center;
    display: flex;
    gap: 8px;

    select {
        min-width: 118px;
    }
}

.empty-state,
.empty-row {
    color: $muted-color;
    padding: 18px 0;
    text-align: center;
}

.table {
    margin-bottom: 0;

    thead th {
        color: $muted-color;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        white-space: nowrap;
    }

    tbody td {
        border-color: $border-color;
        vertical-align: top;
    }

    tbody tr {
        transition: background-color 150ms ease;

        &:hover {
            background: rgba($surface-subtle, 0.55);
        }
    }

    .dark & {
        tbody td {
            border-color: $dark-border-color;
        }
    }
}

@media (max-width: 1100px) {
    .metric-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .metric-card:nth-child(3) {
        border-right: 0;
    }

    .metric-card:nth-child(-n+3) {
        border-bottom: 1px solid $border-color;
    }
}

@media (max-width: 700px) {
    .page-heading,
    .table-tools {
        align-items: stretch;
        flex-direction: column;
    }

    .metric-grid,
    .dashboard-grid,
    .detail-grid,
    .settings-grid {
        grid-template-columns: 1fr;
    }

    .metric-card,
    .metric-card:nth-child(3),
    .metric-card:nth-child(-n+3) {
        min-height: 58px;
        border-right: 0;
        border-bottom: 1px solid $border-color;
    }

    .metric-card:last-child {
        border-bottom: 0;
    }

    .detail-heading {
        flex-direction: column;
    }

    .image-filter,
    .status-select,
    .search-wrapper {
        max-width: none;
    }

    section {
        padding: 14px;
    }

    .container-table {
        overflow: visible;

        thead {
            display: none;
        }

        table,
        tbody,
        tr,
        td {
            display: block;
            width: 100%;
        }

        tbody {
            display: grid;
            gap: 10px;
        }

        tr {
            overflow: hidden;
            padding: 12px;
            border: 1px solid $border-color;
            border-radius: 10px;
            background: $surface;

            .dark & {
                background: $dark-bg2;
                border-color: $dark-border-color;
            }
        }

        td {
            display: grid;
            grid-template-columns: 88px minmax(0, 1fr);
            gap: 10px;
            min-height: 34px;
            padding: 7px 0;
            border-bottom: 1px solid $border-color;

            &::before {
                color: $muted-color;
                font-size: 11px;
                font-weight: 700;
            }

            &:nth-child(1)::before { content: "名称"; }
            &:nth-child(2)::before { content: "Compose"; }
            &:nth-child(3)::before { content: "状态"; }
            &:nth-child(4)::before { content: "镜像"; }
            &:nth-child(5)::before { content: "端口"; }
            &:nth-child(6)::before { content: "CPU"; }
            &:nth-child(7)::before { content: "内存"; }
            &:nth-child(8)::before { content: "数据卷"; }
            &:nth-child(9)::before { content: "缓存"; }
            &:nth-child(10)::before { content: "创建"; }
            &:nth-child(11)::before { content: "启动"; }
            &:nth-child(12)::before { content: "操作"; }

            &:last-child {
                border-bottom: 0;
            }

            .dark & {
                border-color: $dark-border-color;
            }
        }

        .empty-row {
            display: block;

            &::before {
                content: none;
            }
        }
    }

    .skeleton-grid {
        grid-template-columns: 1fr 1fr;
    }
}
</style>
