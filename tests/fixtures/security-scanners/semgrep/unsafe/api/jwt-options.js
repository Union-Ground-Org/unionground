// The production rule must catch each supported verify call shape.
jwt.verify(token, key);
jwt.verify(token, key, { issuer: "fixture" });
jwt.verify(token, key, { issuer: "fixture" }, callback);
jwt.verify(token, key, callback);
