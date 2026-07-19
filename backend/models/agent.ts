import { BeanModel } from "redbean-node/dist/bean-model";
import { R } from "redbean-node";

export interface AgentJSON {
    id: number;
    url: string;
    username: string;
    endpoint: string;
    name: string;
    active: boolean;
    credentialVersion: number;
    credentialConfigured: boolean;
    credentialEncrypted: boolean;
    createdAt: string | null;
    updatedAt: string | null;
}

export class Agent extends BeanModel {

    static async getAgentList() : Promise<Record<string, Agent>> {
        let list = await R.findAll("agent") as Agent[];
        let result : Record<string, Agent> = {};
        for (let agent of list) {
            result[agent.endpoint] = agent;
        }
        return result;
    }

    static async getActiveAgentList() : Promise<Record<string, Agent>> {
        const list = await this.getAgentList();
        return Object.fromEntries(Object.entries(list).filter(([ , agent ]) => Boolean(agent.active)));
    }

    get endpoint() : string {
        let obj = new URL(this.url);
        return obj.host;
    }

    toJSON() : AgentJSON {
        return {
            id: Number(this.id),
            url: this.url,
            username: this.username,
            endpoint: this.endpoint,
            name: this.name,
            active: Boolean(this.active),
            credentialVersion: Number(this.credential_version || 1),
            credentialConfigured: Boolean(this.credential || this.password),
            credentialEncrypted: Boolean(this.credential),
            createdAt: this.created_at || null,
            updatedAt: this.updated_at || null,
        };
    }

}

export default Agent;
