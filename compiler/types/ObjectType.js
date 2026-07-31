"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObjectType = void 0;
class ObjectType {
    // Note: a map that has an empty key ("") uses the corresponding type as default type
    constructor(members = new Map(), isDotDotDot = false, isQuestion = false) {
        this.members = members;
        this.isDotDotDot = isDotDotDot;
        this.isQuestion = isQuestion;
        this.kind = "object";
    }
    toConstructor() {
        return `new ObjectType(new Map<string, Type>([` +
            Array.from(this.members.entries()).map(([n, m]) => `[${JSON.stringify(n)}, ${m.toConstructor()}]`)
                .join(", ") +
            `]), ${this.isDotDotDot}, ${this.isQuestion})`;
    }
    toString() {
        return this.kind;
    }
    convertMember(memberName, memberValue) {
        let type = this.members.get(memberName[0]);
        if (!type) {
            // No type, try to get the default type
            type = this.members.get("");
            if (!type) {
                // No info for this member and no default type, anything goes
                return memberValue;
            }
        }
        if (type.kind === "object") {
            return type.convertMember(memberName.slice(1), memberValue);
        }
        return type.convert(memberValue);
    }
    convert(argument) {
        try {
            return JSON.parse(argument);
        }
        catch (e) {
            throw new Error(`Can't convert to object: ${argument}`);
        }
    }
}
exports.ObjectType = ObjectType;
