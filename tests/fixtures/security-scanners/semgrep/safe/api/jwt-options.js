jwt.verify(token, key, { algorithms: ["RS256"] });
jwt.verify(token, key, { issuer: "fixture", algorithms: ["RS256"] }, callback);
