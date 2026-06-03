from datetime import datetime, timezone

from samaj.db import create_collections

CONFIG = {
    "MONGO_URI": "mongodb+srv://wapro:Ngm7249@cluster0.h324zpy.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0",
    "MONGO_DB": "merasamaj",
    "MONGO_COLLECTION": "data",
    "MONGO_CORRECTIONS_COLLECTION": "transliteration_corrections",
}

LANDMARKS = {
    "temple": "मंदिर",
    "balaji temple": "बालाजी मंदिर",
    "hanuman temple": "हनुमान मंदिर",
    "shiv temple": "शिव मंदिर",
    "mahadev temple": "महादेव मंदिर",
    "ganesh temple": "गणेश मंदिर",
    "sai temple": "साई मंदिर",
    "ram temple": "राम मंदिर",
    "vitthal temple": "विठ्ठल मंदिर",
    "datt mandir": "दत्त मंदिर",

    "school": "स्कूल",
    "primary school": "प्राथमिक स्कूल",
    "high school": "हाई स्कूल",
    "college": "कॉलेज",
    "hostel": "हॉस्टल",

    "hospital": "अस्पताल",
    "clinic": "क्लिनिक",
    "medical store": "मेडिकल स्टोर",

    "bank": "बैंक",
    "atm": "एटीएम",

    "bus stand": "बस स्टैंड",
    "old bus stand": "पुराना बस स्टैंड",
    "new bus stand": "नया बस स्टैंड",
    "railway station": "रेलवे स्टेशन",

    "market": "बाजार",
    "main market": "मुख्य बाजार",
    "market yard": "मार्केट यार्ड",
    "shopping complex": "शॉपिंग कॉम्प्लेक्स",

    "post office": "डाकघर",
    "police station": "पुलिस स्टेशन",
    "gram panchayat": "ग्राम पंचायत",
    "panchayat samiti": "पंचायत समिति",
    "municipal office": "नगरपालिका कार्यालय",
    "court": "न्यायालय",

    "petrol pump": "पेट्रोल पंप",
    "gas agency": "गैस एजेंसी",

    "water tank": "पानी की टंकी",
    "bridge": "पुल",
    "river": "नदी",
    "lake": "तालाब",
    "dam": "बांध",

    "park": "पार्क",
    "garden": "गार्डन",
    "playground": "मैदान",

    "church": "चर्च",
    "masjid": "मस्जिद",
    "mosque": "मस्जिद",
    "dargah": "दरगाह",
    "gurudwara": "गुरुद्वारा",

    "highway": "हाईवे",
    "main road": "मुख्य मार्ग",
    "station road": "स्टेशन रोड",
    "college road": "कॉलेज रोड",
    "road": "सड़क",
    "lane": "गली",
    "street": "सड़क",

    "chowk": "चौक",
    "square": "चौक",
    "circle": "सर्कल",

    "society": "सोसायटी",
    "housing society": "हाउसिंग सोसायटी",
    "colony": "कॉलोनी",
    "apartment": "अपार्टमेंट",
    "building": "इमारत",

    "factory": "फैक्टरी",
    "industrial area": "औद्योगिक क्षेत्र",
    "warehouse": "गोदाम",
}

PATTERNS = {
    "near {x}": "{x} के पास",
    "close to {x}": "{x} के पास",
    "next to {x}": "{x} के पास",
    "beside {x}": "{x} के बगल में",
    "around {x}": "{x} के आसपास",

    "opposite {x}": "{x} के सामने",
    "in front of {x}": "{x} के सामने",

    "behind {x}": "{x} के पीछे",

    "east of {x}": "{x} के पूर्व में",
    "west of {x}": "{x} के पश्चिम में",
    "north of {x}": "{x} के उत्तर में",
    "south of {x}": "{x} के दक्षिण में",

    "inside {x}": "{x} के अंदर",
    "outside {x}": "{x} के बाहर",

    "towards {x}": "{x} की ओर",

    "adjacent to {x}": "{x} के पास",
    "nearby {x}": "{x} के पास",

    "just before {x}": "{x} से पहले",
    "just after {x}": "{x} के बाद",
}

MANUAL_PHRASES = {
    "near balaji temple": "बालाजी मंदिर के पास",
    "near hanuman temple": "हनुमान मंदिर के पास",
    "near shiv temple": "शिव मंदिर के पास",
    "near school": "स्कूल के पास",
    "near hospital": "अस्पताल के पास",
    "near market": "बाजार के पास",

    "balaji temple near": "बालाजी मंदिर के पास",
    "hanuman temple near": "हनुमान मंदिर के पास",
    "shiv temple near": "शिव मंदिर के पास",

    "old bus stand area": "पुराना बस स्टैंड क्षेत्र",
    "new bus stand area": "नया बस स्टैंड क्षेत्र",

    "market road": "मार्केट रोड",
    "station road": "स्टेशन रोड",
    "college road": "कॉलेज रोड",

    "village road": "गांव का रास्ता",
    "main chowk": "मुख्य चौक",
    "bus stand road": "बस स्टैंड रोड",
    "railway station road": "रेलवे स्टेशन रोड",
}


def main():

    client, _, correction_collection = create_collections(CONFIG)

    phrases = {}

    # Auto-generated phrases
    for landmark_en, landmark_hi in LANDMARKS.items():

        for pattern_en, pattern_hi in PATTERNS.items():

            source = pattern_en.format(
                x=landmark_en
            ).lower().strip()

            target = pattern_hi.format(
                x=landmark_hi
            ).strip()

            phrases[source] = target

    # Manual overrides
    phrases.update(MANUAL_PHRASES)

    now = datetime.now(timezone.utc)

    count = 0

    for source, target in phrases.items():

        correction_collection.replace_one(
            {"source": source},
            {
                "source": source,
                "target": target,
                "updatedAt": now,
            },
            upsert=True,
        )

        count += 1

    print(
        f"Imported {count} phrase corrections successfully."
    )

    client.close()


if __name__ == "__main__":
    main()