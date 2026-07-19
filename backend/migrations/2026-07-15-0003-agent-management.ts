import { Knex } from "knex";

export async function up(knex : Knex): Promise<void> {
    await knex.schema.alterTable("agent", table => {
        table.text("credential").nullable();
        table.integer("credential_version").notNullable().defaultTo(1);
        table.datetime("created_at").nullable();
        table.datetime("updated_at").nullable();
    });
    await knex("agent").whereNull("created_at").update({ created_at: knex.fn.now(),
        updated_at: knex.fn.now() });
}

export async function down(knex : Knex): Promise<void> {
    await knex.schema.alterTable("agent", table => {
        table.dropColumn("credential");
        table.dropColumn("credential_version");
        table.dropColumn("created_at");
        table.dropColumn("updated_at");
    });
}
