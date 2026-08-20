CREATE TABLE "agent_model_switch_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"adapter_type" text,
	"mappings" jsonb NOT NULL,
	"env" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_model_switch_presets_company_name_uq" UNIQUE("company_id","name")
);
--> statement-breakpoint
ALTER TABLE "agent_model_switch_presets" ADD CONSTRAINT "agent_model_switch_presets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_model_switch_presets_company_idx" ON "agent_model_switch_presets" USING btree ("company_id");