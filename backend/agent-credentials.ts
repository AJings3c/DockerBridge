import crypto from "node:crypto";
import { ValidationError } from "./util-server";

const FORMAT_VERSION = "v1";

export class AgentCredentialCipher {
    private readonly key : Buffer;
    readonly externalKeyConfigured : boolean;

    constructor(serverSecret : string) {
        const configured = process.env.DOCKERBRIDGE_AGENT_CREDENTIAL_KEY;
        this.externalKeyConfigured = Boolean(configured);
        const source = configured || serverSecret;
        if (!source) {
            throw new Error("Agent credential encryption key is unavailable");
        }
        this.key = crypto.createHash("sha256").update("dockerbridge-agent-credentials-v1\0").update(source).digest();
    }

    encrypt(password : string) {
        if (typeof password !== "string" || !password) {
            throw new ValidationError("Agent password is required");
        }
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
        const encrypted = Buffer.concat([ cipher.update(password, "utf-8"),
            cipher.final() ]);
        const tag = cipher.getAuthTag();
        return [ FORMAT_VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url") ].join(":");
    }

    decrypt(value : string) {
        if (typeof value !== "string") {
            throw new ValidationError("Stored Agent credential is invalid");
        }
        const [ version, ivValue, tagValue, encryptedValue, ...extra ] = value.split(":");
        if (version !== FORMAT_VERSION || !ivValue || !tagValue || !encryptedValue || extra.length > 0) {
            throw new ValidationError("Stored Agent credential format is unsupported");
        }
        try {
            const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivValue, "base64url"));
            decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
            return Buffer.concat([ decipher.update(Buffer.from(encryptedValue, "base64url")),
                decipher.final() ]).toString("utf-8");
        } catch (error) {
            throw new ValidationError("Stored Agent credential could not be decrypted; verify DOCKERBRIDGE_AGENT_CREDENTIAL_KEY");
        }
    }
}
