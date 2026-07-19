export class AgentSocket {

    constructor(private authorize? : (eventName: string) => void) {
    }

    eventList : Map<string, (...args : unknown[]) => void> = new Map();

    on(event : string, callback : (...args : unknown[]) => void) {
        this.eventList.set(event, callback);
    }

    call(eventName : string, ...args : unknown[]) {
        const callback = this.eventList.get(eventName);
        if (callback) {
            this.authorize?.(eventName);
            callback(...args);
            return true;
        }
        return false;
    }
}
