import { Knex } from "knex";
import { sanitizeOperationLogValue } from "../operation-log";

interface OperationLogRow {
    id: number;
    before_json: string | null;
    after_json: string | null;
    error: string | null;
}

function sanitizeJSON(value : string | null) {
    if (value == null) {
        return null;
    }
    try {
        return JSON.stringify(sanitizeOperationLogValue(JSON.parse(value)));
    } catch (error) {
        return JSON.stringify(sanitizeOperationLogValue(value));
    }
}

export async function up(knex : Knex): Promise<void> {
    let lastId = 0;
    while (true) {
        const rows = await knex<OperationLogRow>("dockerbridge_operation_log")
            .select("id", "before_json", "after_json", "error")
            .where("id", ">", lastId)
            .orderBy("id")
            .limit(250);
        if (rows.length === 0) {
            return;
        }
        for (const row of rows) {
            const before = sanitizeJSON(row.before_json);
            const after = sanitizeJSON(row.after_json);
            const error = row.error == null ? null : String(sanitizeOperationLogValue(row.error));
            if (before !== row.before_json || after !== row.after_json || error !== row.error) {
                await knex("dockerbridge_operation_log").where("id", row.id).update({
                    before_json: before,
                    after_json: after,
                    error,
                });
            }
        }
        lastId = Number(rows.at(-1)?.id || lastId);
    }
}

export async function down() : Promise<void> {
    // Redacted secrets cannot and should not be reconstructed.
}
