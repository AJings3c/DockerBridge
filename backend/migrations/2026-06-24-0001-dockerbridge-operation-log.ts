import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    return knex.schema.createTable("dockerbridge_operation_log", (table) => {
        table.increments("id");
        table.dateTime("time").notNullable();
        table.string("action_type", 80).notNullable();
        table.string("object_type", 80).notNullable();
        table.string("object_id", 255).notNullable();
        table.text("before_json");
        table.text("after_json");
        table.string("result", 40).notNullable();
        table.text("error");
    });
}

export async function down(knex: Knex): Promise<void> {
    return knex.schema.dropTable("dockerbridge_operation_log");
}
