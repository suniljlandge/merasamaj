from pymongo import MongoClient


def create_collections(config):
    client = MongoClient(config["MONGO_URI"])
    database = client[config["MONGO_DB"]]
    collection = database[config["MONGO_COLLECTION"]]
    correction_collection = database[config["MONGO_CORRECTIONS_COLLECTION"]]
    collection.create_index([("createdAt", -1)])
    collection.create_index("mobileNumber")
    correction_collection.create_index("source", unique=True)
    correction_collection.create_index([("updatedAt", -1)])
    return client, collection, correction_collection


def create_collection(config):
    client, collection, _correction_collection = create_collections(config)
    return client, collection
