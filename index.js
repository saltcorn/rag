const dependencies = ["@saltcorn/large-language-model", "@saltcorn/pgvector"];
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
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
        const llm_config =
          getState().plugin_cfgs["large-language-model"] ||
          getState().plugin_cfgs["@saltcorn/large-language-model"];
        const override_fields =
          llm_config?.backend === "OpenAI-compatible API" &&
          (llm_config?.altconfigs || []).filter((c) => c.name).length
            ? [
                {
                  name: "override_config",
                  label: "Alternative LLM configuration",
                  type: "String",
                  attributes: {
                    options: llm_config?.altconfigs.map((c) => c.name),
                  },
                },
              ]
            : [];

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
        configuration: { text_field, text_formula, vec_field, override_config },
      }) => {
        const embedF = getState().functions.llm_embedding;
        const opts = {};
        if (override_config) {
          const llm_config =
            getState().plugin_cfgs["large-language-model"] ||
            getState().plugin_cfgs["@saltcorn/large-language-model"];
          const altcfg = llm_config.altconfigs.find(
            (c) => c.name === override_config
          );
          opts.endpoint = altcfg.endpoint;
          opts.model = altcfg.model;
          opts.api_key = altcfg.api_key;
          opts.bearer = altcfg.bearer;
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
            attributes: { options: ["Paragraphs", "Sentences"] },
          },
          {
            name: "locale",
            label: "Locale",
            type: "String",
            showIf: { strategy: "Sentences" },
          },
        ];
      },
      run: async ({
        row,
        table,
        mode,
        user,
        configuration: {
          joined_table,
          chunk_field,
          text_field,
          strategy,
          locale,
        },
      }) => {
        const [join_table_name, join_field] = joined_table.split(".");
        const joinTable = Table.findOne({ name: join_table_name });
        if (!joinTable)
          throw new Error(
            `Table ${join_table_name} not found in insert_joined_row action`
          );
        const doc = row[text_field];

        if (!doc) return;

        let chunks = [];
        switch (strategy) {
          case "Sentences":
            const segmenter = new Intl.Segmenter(
              locale || getState().getConfig("default_locale", "en"),
              {
                granularity: "sentence",
              }
            );

            chunks = Array.from(segmenter.segment(doc), (s) => s.segment);

            break;
          default:
            chunks = doc
              .split(/\r?\n\r?\n/)
              .map((c) => c.trim())
              .filter(Boolean);
            break;
        }

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
        const relation_opts = {};
        for (const table of allTables) {
          table.fields
            .filter((f) => f.type?.name === "PGVector")
            .forEach((f) => {
              const relNm = `${table.name}.${f.name}`;
              tableOpts.push(relNm);
              const fkeys = table.fields
                .filter((f) => f.is_fkey)
                .map((f) => f.name);
              relation_opts[relNm] = ["", ...fkeys];
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
            name: "doc_relation",
            label: "Document relation",
            sublabel:
              "Optional. For each vector match, retrieve row in the table related by this key instead",
            type: "String",
            required: true,
            attributes: { calcOptions: ["vec_field", relation_opts] },
          },
          {
            name: "search_term_expr",
            label: "Search term",
            class: "validate-expression",
            sublabel:
              "JavaScript expression, based on the context, for the search term",
            type: "String",
          },
          {
            name: "where_expr",
            label: "Where",
            class: "validate-expression",
            sublabel:
              "Optional. JavaScript where-expression to restrict chunks searched",
            type: "String",
          },
          {
            name: "where_doc_expr",
            label: "Where doc",
            class: "validate-expression",
            sublabel:
              "Optional. JavaScript where-expression to restrict documents searched",
            type: "String",
            showIf: { doc_relation: Object.values(relation_opts).flat(1) },
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
            class: "validate-identifier",
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
        configuration: {
          vec_field,
          doc_relation,
          search_term_expr,
          where_expr,
          where_doc_expr,
          found_variable,
          limit,
        },
      }) => {
        const search_term = eval_expression(
          search_term_expr,
          row,
          user,
          "search term formula"
        );
        const where_obj = where_expr
          ? eval_expression(
              where_expr,
              row,
              user,
              "where expression in vector_similarity_search"
            )
          : {};
        const [table_name, field_name] = vec_field.split(".");
        const table = Table.findOne({ name: table_name });
        if (!table)
          throw new Error(
            `Table ${table_name} not found in vector_similarity_search action`
          );
        if (where_doc_expr) {
          const relField = table.getField(doc_relation);
          const relTable = Table.findOne(relField.reftable_name);
          where_obj[doc_relation] = {
            inSelect: {
              tenant: db.getTenantSchema(),
              field: relTable.pk_name,
              table: relTable.name,
              where: eval_expression(
                where_doc_expr,
                row,
                user,
                "where doc expression in vector_similarity_search"
              ),
            },
          };
        }
        const embedF = getState().functions.llm_embedding;
        const opts = {};
        const qembed = await embedF.run(search_term, opts);
        const selLimit = +(limit || 10);
        const vmatch = await table.getRows(where_obj, {
          orderBy: {
            operator: "nearL2",
            field: field_name,
            target: JSON.stringify(qembed),
          },
          limit: doc_relation ? 5 * selLimit : selLimit,
        });
        if (!doc_relation) return { [found_variable]: vmatch };
        else {
          const relField = table.getField(doc_relation);
          const relTable = Table.findOne(relField.reftable_name);
          const ids = [];
          vmatch.forEach((vrow) => {
            if (ids.length < selLimit) ids.push(vrow[doc_relation]);
          });
          const docsUnsorted = await relTable.getRows({ id: { in: ids } });
          //ensure order
          const docs = ids
            .map((id) => docsUnsorted.find((d) => d.id == id))
            .filter(Boolean);
          return { [found_variable]: docs };
        }
      },
    },
  },
};
