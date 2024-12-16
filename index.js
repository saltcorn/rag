const dependencies = ["@saltcorn/large-language-model", "@saltcorn/pgvector"];
const { getState } = require("@saltcorn/data/db/state");

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "rag",
  dependencies,
  actions: {
    get_embedding: {
      requireRow: true,
      configFields: ({ table, mode }) => {
        if (table) {
          const vecFields = table.fields
            .filter((f) => f.type?.name === "PGVector")
            .map((f) => f.name);
          const textFields = table.fields
            .filter((f) => f.type?.sql_name === "text")
            .map((f) => f.name);

          const cfgFields = [
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
          return cfgFields;
        }
      },
      run: async ({
        row,
        table,
        configuration: {
          text_field,
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
        const vec = await embedF.run(row[text_field], opts);
        await table.updateRow(
          { [vec_field]: JSON.stringify(vec) },
          row[table.pk_name]
        );
      },
    },
  },
};
