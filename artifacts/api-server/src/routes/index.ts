import { Router, type IRouter } from "express";
import healthRouter from "./health";
import telegramRouter from "./telegram";

const router: IRouter = Router();

router.use(healthRouter);
router.use(telegramRouter);

export default router;
