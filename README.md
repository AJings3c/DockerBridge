<div align="center">
  <img src="./frontend/public/icon.svg" width="112" alt="DockerBridge" />
  <h1>DockerBridge</h1>
  <p>面向自托管 Docker 与 Compose 环境的一体化管理平台</p>
</div>

> [!IMPORTANT]
> **DockerBridge 是基于 [louislam/dockge](https://github.com/louislam/dockge) 的社区二次开发项目。**
> 它不是 Dockge 官方版本，与 Dockge 官方及原作者不存在隶属或背书关系。项目保留上游的 MIT 许可和版权声明，详见 [LICENSE](./LICENSE)。

DockerBridge 在 Dockge 的 Compose 项目管理能力上继续开发，增加 Docker 资源管理、多节点 Agent、权限审计、备份恢复和 Web 终端，并使用 React 重构主要管理界面。界面采用克制的半透明层级、响应式布局、可中断手势与减少动态效果适配，目标是在桌面和移动端提供一致、直接的运维体验。

## 已实现能力

- **运行总览**：聚合容器、Compose 项目、镜像和异常状态，支持自动刷新与快速定位。
- **容器与镜像**：查看详情、日志、端口和生命周期状态，支持安全的端口修改、回滚与显式缓存目录清理。
- **Compose 工作区**：编辑 `compose.yaml` 与 `.env`、预览变更、保存版本、恢复历史版本、部署项目，并扫描指定目录中的 Compose 配置。
- **Docker 资源**：管理网络与数据卷，涉及断开连接等高风险操作时提供预览和确认。
- **Agent 节点**：注册和管理远程 DockerBridge 节点，提供连接测试、运行诊断、凭据轮换和删除影响预览。
- **账号与审计**：支持 `viewer`、`operator`、`admin` 三级角色、用户管理、权限校验、敏感信息脱敏及操作日志。
- **备份与恢复**：支持 `daemon.json` 变更预览、自动备份、回滚与重启；DockerBridge 备份覆盖 SQLite 数据、数据库配置和托管的 Compose 文件，并提供校验、恢复预览、恢复与删除。
- **Web 终端**：提供经过认证和授权的交互式终端，包含会话上限、空闲超时和关闭清理。

## 运行要求

- Node.js `>= 22.14.0`
- Docker Engine 或兼容的 Docker API
- Docker Compose V2
- 建议使用能够挂载 Docker Socket 的 Linux 主机部署容器版本

挂载 `/var/run/docker.sock` 等同于授予 Docker 管理权限。请仅向受信任用户开放 DockerBridge，并在生产环境中使用反向代理、HTTPS 和严格的账号权限。

DockerBridge 备份不包含 Docker 镜像、数据卷或整台宿主机，当前仅支持 SQLite 数据库。Docker daemon 配置操作还需要挂载配置文件并设置 `DOCKERBRIDGE_DAEMON_JSON`。

## Docker Compose 启动

仓库中的 `compose.yaml` 默认使用 `kilomac/dockerbridge:latest`，将数据保存在 `./data`，将 Compose 项目保存在 `/opt/stacks`，并监听 `8612` 端口：

```bash
git clone https://github.com/AJings3c/DockerBridge.git
cd DockerBridge
docker compose up -d
```

启动后访问 <http://localhost:8612> 并创建首个管理员账号。

> `docker compose up -d` 运行的是 `compose.yaml` 中声明的镜像，不会自动编译刚拉取的源码。需要验证当前源码时，请使用下方源码方式运行，或先构建镜像并替换 `image` 配置。

## 从源码运行

确保本机能够访问 Docker daemon，然后执行：

```bash
npm ci
npm run build:frontend
npm run start:console
```

默认访问地址仍为 <http://localhost:8612>。`start:console` 会启用 `runtime` 终端；不需要 Web 终端时可改用 `npm start`。

常用质量检查：

```bash
npm test
npm run check-ts
npm run lint
```

## 终端范围与安全边界

默认 `compose.yaml` 使用：

```yaml
environment:
  - DOCKERBRIDGE_ENABLE_CONSOLE=true
  - DOCKERBRIDGE_CONSOLE_TARGET=runtime
```

这意味着在 Docker Compose 部署中，终端进入的是 **DockerBridge 容器运行环境**，不会直接进入宿主机。若通过源码直接在宿主机运行，`runtime` 就是启动 DockerBridge 进程的宿主机环境。

只有在 Linux 宿主机上显式启用下列高权限配置时，终端才会通过 `nsenter` 进入宿主机：

```yaml
services:
  dockerbridge:
    pid: host
    privileged: true
    environment:
      - DOCKERBRIDGE_ENABLE_CONSOLE=true
      - DOCKERBRIDGE_CONSOLE_TARGET=host
```

宿主机终端等同于管理员 Shell。除非明确需要并理解风险，否则应保持默认的 `runtime` 模式。

## 项目关系与许可

- 上游项目：[Dockge](https://github.com/louislam/dockge)
- 二次开发项目：[DockerBridge](https://github.com/AJings3c/DockerBridge)
- 许可协议：MIT，原始版权与许可文本保留在 [LICENSE](./LICENSE)

DockerBridge 名称、界面和新增功能属于本二次开发项目的演进方向；涉及 Dockge 原始代码的部分继续遵循其 MIT 许可。
