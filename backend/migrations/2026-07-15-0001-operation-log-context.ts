import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    return knex.schema.alterTable("dockerbridge_operation_log", (table) => {
        table.string("actor", 255);
        table.string("endpoint", 255);
        table.integer("duration_ms");
        table.index([ "time" ], "dockerbridge_operation_log_time_index");
        table.index([ "result", "time" ], "dockerbridge_operation_log_result_time_index");
        table.index([ "action_type", "time" ], "dockerbridge_operation_log_action_time_index");
    });
}

export async function down(knex: Knex): Promise<void> {
    return knex.schema.alterTable("dockerbridge_operation_log", (table) => {
        table.dropIndex([ "time" ], "dockerbridge_operation_log_time_index");
        table.dropIndex([ "result", "time" ], "dockerbridge_operation_log_result_time_index");
        table.dropIndex([ "action_type", "time" ], "dockerbridge_operation_log_action_time_index");
        table.dropColumn("actor");
        table.dropColumn("endpoint");
        table.dropColumn("duration_ms");
    });
}
