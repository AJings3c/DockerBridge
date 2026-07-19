import { DockgeServer } from "./dockge-server";
import { log } from "./log";

log.info("server", "Welcome to DockerBridge!");
const server = new DockgeServer();
await server.serve();
