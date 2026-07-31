"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClassMetadata = void 0;
class ClassMetadata {
    constructor(members = new Map()) {
        this.members = members;
    }
    setMember(name, s) {
        this.members.set(name, s);
    }
    getMember(name) {
        return this.members.get(name);
    }
    getMembers() {
        return this.members.keys();
    }
    toConstructor() {
        return (`new ClassMetadata(new Map<string, SymbolMetadata>([` +
            Array.from(this.members.entries())
                .map(([n, m]) => `[${JSON.stringify(n)}, ${m.toConstructor()}]`)
                .join(",\n") +
            `]))`);
    }
}
exports.ClassMetadata = ClassMetadata;
