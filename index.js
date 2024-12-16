const dependencies = ["@saltcorn/large-language-model", "@saltcorn/pgvector"];
const { getState } = require("@saltcorn/data/db/state");
const { eval_expression } = require("@saltcorn/data/models/expression");
const Table = require("@saltcorn/data/models/table");

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "rag",
  dependencies,
  actions: {
    get_embedding: {
      requireRow: true,
      configFields: ({ table, mode }) => {
        const override_fields = [
          {
            name: "override_config",
            label: "Override LLM configuration",
            type: "Bool",
          },
          {
            name: "override_endpoint",
            label: "Endpoint",
            type: "String",
            showIf: { override_config: true },
          },
          {
            name: "override_model",
            label: "Model",
            type: "String",
            showIf: { override_config: true },
          },
          {
            name: "override_apikey",
            label: "API key",
            type: "String",
            showIf: { override_config: true },
          },
          {
            name: "override_bearer",
            label: "Bearer",
            type: "String",
            showIf: { override_config: true },
          },
        ];
        if (mode === "workflow") {
          return [
            {
              name: "text_formula",
              label: "Text expression",
              sublabel:
                "JavaScript expression evalutating to the text to be embedded, based on the context",
              type: "String",
              required: true,
            },
            {
              name: "vec_field",
              label: "Vector variable",
              sublabel:
                "Set the generated embedding vector to this context variable",
              type: "String",
              required: true,
            },
            ...override_fields,
          ];
        }
        if (table) {
          const vecFields = table.fields
            .filter((f) => f.type?.name === "PGVector")
            .map((f) => f.name);
          const textFields = table.fields
            .filter((f) => f.type?.sql_name === "text")
            .map((f) => f.name);

          return [
            {
              name: "text_field",
              label: "Text field",
              sublabel: "Field with the source document",
              type: "String",
              required: true,
              attributes: { options: textFields },
            },
            {
              name: "vec_field",
              label: "Vector field",
              sublabel: "Output field will be set to the embedding vector",
              type: "String",
              required: true,
              attributes: { options: vecFields },
            },
            ...override_fields,
          ];
        }
      },
      run: async ({
        row,
        table,
        mode,
        user,
        configuration: {
          text_field,
          text_formula,
          vec_field,
          override_config,
          override_endpoint,
          override_model,
          override_apikey,
          override_bearer,
        },
      }) => {
        const embedF = getState().functions.llm_embedding;
        const opts = {};
        if (override_config) {
          opts.endpoint = override_endpoint;
          opts.model = override_model;
          opts.apikey = override_apikey;
          opts.bearer = override_bearer;
        }
        const text =
          mode === "workflow"
            ? eval_expression(
                text_formula,
                row,
                user,
                "get_embedding text formula"
              )
            : row[text_field];

        const vec = await embedF.run(text, opts);
        if (mode === "workflow") return { [vec_field]: JSON.stringify(vec) };
        await table.updateRow(
          { [vec_field]: JSON.stringify(vec) },
          row[table.pk_name]
        );
      },
    },
    chunk_document: {
      requireRow: true,
      configFields: async ({ table, mode }) => {
        if (!table) return [];
        const textFields = table.fields
          .filter((f) => f.type?.sql_name === "text")
          .map((f) => f.name);
        const { child_field_list, child_relations } =
          await table.get_child_relations();
        const chunkOptions = {};
        child_relations.forEach(({ key_field, table }) => {
          chunkOptions[`${table.name}.${key_field.name}`] = table.fields
            .filter((f) => f.type.sql_name === "text")
            .map((f) => f.name);
        });
        return [
          {
            name: "text_field",
            label: "Text field",
            sublabel: "Field with the source document",
            type: "String",
            required: true,
            attributes: { options: textFields },
          },
          {
            name: "joined_table",
            label: "Relation",
            sublabel: "Relation to chunks table",
            input_type: "select",
            options: child_field_list,
          },
          {
            name: "chunk_field",
            label: "Chunk field",
            type: "String",
            required: false,
            attributes: {
              calcOptions: ["joined_table", chunkOptions],
            },
          },
          {
            name: "strategy",
            label: "Chunking strategy",
            type: "String",
            required: true,
            attributes: { options: ["Paragraphs"] },
          },
        ];
      },
      run: async ({
        row,
        table,
        mode,
        user,
        configuration: { joined_table, chunk_field, text_field, strategy },
      }) => {
        const [join_table_name, join_field] = joined_table.split(".");
        const joinTable = Table.findOne({ name: join_table_name });
        if (!joinTable)
          throw new Error(
            `Table ${join_table_name} not found in insert_joined_row action`
          );
        const doc = row[text_field];

        if (!doc) return;
        const chunks = doc
          .split(/\r?\n\r?\n/)
          .map((c) => c.trim())
          .filter(Boolean);

        for (const chunk of chunks) {
          const newRow = {
            [join_field]: row[table.pk_name],
            [chunk_field]: chunk,
          };
          await joinTable.insertRow(newRow);
        }
      },
    },
    vector_similarity_search: {      
      configFields: async ({ table, mode }) => {
        if (mode !== "workflow") return [];
        const allTables = await Table.find();
        const tableOpts = [];
        for (const table of allTables) {
          table.fields
            .filter((f) => f.type?.name === "PGVector")
            .forEach((f) => {
              tableOpts.push(`${table.name}.${f.name}`);
            });
        }
        return [
          {
            name: "vec_field",
            label: "Vector field",
            sublabel: "Field to search for vector similarity",
            type: "String",
            required: true,
            attributes: { options: tableOpts },
          },
          {
            name: "search_term_expr",
            label: "Search term",
            sublabel:
              "JavaScript expression, based on the context, for the search term",
            type: "String",
          },
          {
            name: "limit",
            label: "Limit",
            sublabel: "Max number of rows to find",
            type: "String",
          },
          {
            name: "found_variable",
            label: "Result variable",
            sublabel: "Set this context variable to the array of found rows",
            type: "String",
            required: true,
          },
        ];
      },
      run: async ({
        row,
        mode,
        user,
        configuration: { vec_field, search_term_expr, found_variable, limit },
      }) => {
        const search_term = eval_expression(
          search_term_expr,
          row,
          user,
          "search term formula"
        );
        const embedF = getState().functions.llm_embedding;
        const opts = {};
        const qembed = await embedF.run(search_term, opts);
        const [table_name, field_name] = vec_field.split(".");
        const table = Table.findOne({ name: table_name });
        if (!table)
          throw new Error(
            `Table ${table_name} not found in vector_similarity_search action`
          );
        const docs = await table.getRows(
          {},
          {
            orderBy: {
              operator: "nearL2",
              field: field_name,
              target: JSON.stringify(qembed),
            },
            limit: +(limit || 10),
          }
        );
        return { [found_variable]: docs };
      },
    },
  },
};
