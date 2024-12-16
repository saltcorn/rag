# rag
Actions for Retrieval-Augmented Generation

This module provides actions for implementing retrieval augmented generation in saltcorn.

### chunk document action

This action will break a larger markdown document into chunks and insert them on a related table. It is configured by selecting the field that has the entire document,  an inbound table and a text field on the inbound table which will contain the text chunks. You also select the chunking strategy but there is currently only one strategy, to split the document into paragraphs.

You could set this up as an insert trigger on a table.

### get embedding action 

This action will calculate the vector embedding for a piece of text and place it on a field on the same table that contains the field with the text. The action is configured by choosing the text and the vector field, and also has an option for overriding the LLM model and endpoint configuration.

It is recommended that you create a table with one text field and one vector field and select this as an action for an insert trigger on this table.