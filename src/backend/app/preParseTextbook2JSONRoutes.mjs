import express from "express";
import { preParseTextbook2JSON } from "../domain/preParseTextbook2JSON/index.mjs";

export function createPreParseTextbook2JSONRouter() {
  const router = express.Router();

  router.post("/preParseTextbook2JSON", async (req, res, next) => {
    try {
      const textbook = await preParseTextbook2JSON(req.body);
      res.json(textbook);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
