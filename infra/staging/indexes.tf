locals {
  composite_indexes = {
    items_published = { collection = "items", fields = ["ownerUid:ASCENDING", "status:ASCENDING", "publishedAt:DESCENDING"] }
    items_created   = { collection = "items", fields = ["ownerUid:ASCENDING", "status:ASCENDING", "createdAt:DESCENDING"] }
    feed            = { collection = "items", fields = ["status:ASCENDING", "visibility:ASCENDING", "publishedAt:DESCENDING"] }
    products        = { collection = "items", fields = ["ownerUid:ASCENDING", "productKey:ASCENDING"] }
    runs            = { collection = "agentRuns", fields = ["uid:ASCENDING", "agent:ASCENDING", "startedAt:DESCENDING"] }
  }
}
resource "google_firestore_index" "app" {
  for_each   = local.composite_indexes
  collection = each.value.collection
  database   = google_firestore_database.app.name
  dynamic "fields" {
    for_each = each.value.fields
    content {
      field_path = split(":", fields.value)[0]
      order      = split(":", fields.value)[1]
    }
  }
}
resource "google_firestore_field" "wish_cleanup" {
  for_each   = toset(["itemId", "ownerUid"])
  collection = "wishes"
  field      = each.value
  database   = google_firestore_database.app.name
  index_config {
    indexes {
      order       = "ASCENDING"
      query_scope = "COLLECTION"
    }
    indexes {
      order       = "ASCENDING"
      query_scope = "COLLECTION_GROUP"
    }
  }
}
resource "google_firestore_index" "taste" {
  collection = "users"
  database   = google_firestore_database.app.name
  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
  fields {
    field_path = "tasteVector"
    vector_config {
      dimension = 768
      flat {}
    }
  }
}
