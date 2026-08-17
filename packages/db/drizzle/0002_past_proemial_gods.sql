CREATE TABLE "item_class_slots" (
	"defindex" integer NOT NULL,
	"class_num" smallint NOT NULL,
	"slot" smallint NOT NULL,
	CONSTRAINT "item_class_slots_defindex_class_num_slot_pk" PRIMARY KEY("defindex","class_num","slot")
);
