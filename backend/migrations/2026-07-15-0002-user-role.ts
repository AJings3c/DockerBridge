import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    return knex.schema.alterTable("user", (table) => {
        table.string("role", 24).notNullable().defaultTo("admin").index();
    });
}

export async function down(knex: Knex): Promise<void> {
    return knex.schema.alterTable("user", (table) => {
        table.dropColumn("role");
    });
}
