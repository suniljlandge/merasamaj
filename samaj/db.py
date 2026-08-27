from pymongo import MongoClient


CITY_OWNED_COLLECTIONS = (
    "users",
    "public_accounts",
    "self_registrations",
    "campaigns",
    "campaign_payments",
    "campaign_messages",
)


def ensure_tenant_indexes(database, registration_collection):
    registration_collection.create_index("cityId")

    for collection_name in CITY_OWNED_COLLECTIONS:
        database[collection_name].create_index("cityId")

    database["cities"].create_index("nameKey", unique=True)
    database["cities"].create_index("isActive")
    database["city_transfers"].create_index(
        [("sourceCityId", 1), ("changedAt", -1)]
    )
    database["city_transfers"].create_index(
        [("destinationCityId", 1), ("changedAt", -1)]
    )
    database["city_transfers"].create_index(
        [("entityType", 1), ("entityId", 1), ("changedAt", -1)]
    )


def create_collections(config):
    client = MongoClient(config["MONGO_URI"])
    database = client[config["MONGO_DB"]]
    collection = database[config["MONGO_COLLECTION"]]
    correction_collection = database[config["MONGO_CORRECTIONS_COLLECTION"]]
    collection.create_index([("createdAt", -1)])
    collection.create_index("mobileNumber")

    collection.create_index(
        "surnameGroup"
    )

    collection.create_index(
        "district"
    )

    collection.create_index(
        "taluka"
    )

    collection.create_index(
        [
            ("firstName.en", "text"),
            ("lastName.en", "text"),
            ("firstName.mr", "text"),
            ("lastName.mr", "text"),
        ]
    )
    correction_collection.create_index("source", unique=True)
    correction_collection.create_index([("updatedAt", -1)])
    ensure_tenant_indexes(database, collection)
    return client, collection, correction_collection


def create_collection(config):
    client, collection, _correction_collection = create_collections(config)
    return client, collection


def get_database(config):
    client = MongoClient(config["MONGO_URI"])
    return client[config["MONGO_DB"]]
