CREATE TABLE "import_source_mappings" (
	"import_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"source_id" text NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_source_mappings_import_id_entity_type_source_id_pk" PRIMARY KEY("import_id","entity_type","source_id"),
	CONSTRAINT "import_source_mappings_entity_type" CHECK ("import_source_mappings"."entity_type" in ('project', 'asset'))
);
--> statement-breakpoint
ALTER TABLE "import_source_mappings" ADD CONSTRAINT "import_source_mappings_workspace_id_import_id_imports_workspace_id_id_fk" FOREIGN KEY ("workspace_id","import_id") REFERENCES "public"."imports"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_source_mappings_target_idx" ON "import_source_mappings" USING btree ("workspace_id","target_id");