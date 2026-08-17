import { Router, type IRouter } from "express";
import healthRouter from "./health";
import telegramRouter from "./telegram";
import signingRouter from "./signing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(telegramRouter);
router.use(signingRouter);

export default router;
