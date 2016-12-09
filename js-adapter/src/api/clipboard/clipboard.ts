import { Base } from "../base";
import { WriteRequestType, WriteAnyRequestType } from "./write-request";

export default class Clipboard extends Base {

    writeText(writeObj: WriteRequestType): Promise<void> {
        return this.wire.sendAction("clipboard-write-text", writeObj);
    }
    
    readText(type?: string): Promise<string> {
        return this.wire.sendAction("clipboard-read-text", type)
            .then(({ payload }) => payload.data);
    }

    writeHtml(writeObj: WriteRequestType): Promise<void> {
        return this.wire.sendAction("clipboard-write-html", writeObj);
    }

    readHtml(type?: string): Promise<string> {
        return this.wire.sendAction("clipboard-read-html", type)
            .then(({ payload }) => payload.data);
    }

    writeRtf(writeObj: WriteRequestType): Promise<void> {
        return this.wire.sendAction("clipboard-write-rtf", writeObj);
    }

    readRtf(type?: string): Promise<string> {
        return this.wire.sendAction("clipboard-read-rtf", type)
            .then(({ payload }) => payload.data);
    }

    write(writeObj: WriteAnyRequestType): Promise<void> {
        return this.wire.sendAction("clipboard-write", writeObj);
    }

    getAvailableFormats(type?: string): Promise<Array<string>> {
        return this.wire.sendAction("clipboard-read-formats", type)
            .then(({ payload }) => payload.data);
    }
}
