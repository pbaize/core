import Transport from "../transport/transport"
import { Identity, NoIdentity } from "../identity"

abstract class Base {
    protected identity: Identity 
    constructor(protected wire: Transport, protected token?: string) {}
    addEventListener(type: string, listener: Function): Promise<void> {
        if (this.identity)
            return this.wire.subscribeToEvent(this.identity, this.topic, type, listener)
        else    
            return Promise.reject(new NoIdentity)
    }
    protected get topic(): string {
        return this.constructor.name.replace("_", "").toLowerCase()
    }
}
export default Base