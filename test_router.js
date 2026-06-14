import { routeSafety } from "./server/services/deterministicSafetyRouter.js";

console.log("GREEN Test:", routeSafety({ message: "I want to sleep earlier and reduce screen time" }).level);
console.log("YELLOW Test:", routeSafety({ message: "I have fever and stomach pain since yesterday" }).level);
console.log("RED Test:", routeSafety({ message: "I have chest pain and shortness of breath" }).level);
console.log("MEDICATION Test:", routeSafety({ message: "Which medicine should I take for headache?" }).action);
