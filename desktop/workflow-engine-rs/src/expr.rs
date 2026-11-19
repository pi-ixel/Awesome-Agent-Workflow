//! 工作流源码里的一行表达式 → 引擎的 JSON 表达式树（`graph::evaluate` 的输入）。
//!
//! 语法（详见 `docs/workflow-format.md`）：
//! - 字面量：`1`、`"text"`、`true`、`false`、`null`、常量数组 `[..]`、对象 `{k: v}`；
//! - 引用：`vars.x`、`input.x`、`item`、`index`、`previous.x`，或节点 / 调用步骤的名字
//!   （取它最近一次的结果，如 `design_review.decision`）；`a.b`、`a["键"]`、`a[i]`；
//! - 运算：`!`、`+`、`== != < > <= >=`、`&&`、`||`、`条件 ? 甲 : 乙`；
//! - 函数：`len(x)`、`nonempty(x)`、`merge(a, b, ..)`、`every(列表, 条件)`、
//!   `items_valid(列表, ["字段", ..], "唯一字段")`、`get(对象, 键)`。
//!
//! 解析与解析名字分两步：先得到语法树，再由调用方给出「哪些名字是节点」来落成
//! 路径，名字认不出时报错并列出可用的名字。
use serde_json::{Map, Value, json};

#[derive(Debug, Clone, PartialEq)]
pub enum Ast {
    Const(Value),
    Array(Vec<Ast>),
    Object(Vec<(String, Ast)>),
    Name(String),
    Field(Box<Ast>, String),
    Index(Box<Ast>, Box<Ast>),
    Call(String, Vec<Ast>),
    Not(Box<Ast>),
    Binary(String, Box<Ast>, Box<Ast>),
    Ternary(Box<Ast>, Box<Ast>, Box<Ast>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExprError {
    /// 出错位置：表达式内的字符序号（从 0 开始）。
    pub offset: usize,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64, bool),
    Str(String),
    Ident(String),
    Op(&'static str),
    End,
}

fn lex(text: &str) -> Result<Vec<(Tok, usize)>, ExprError> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    const OPS: [&str; 22] = [
        "==", "!=", "<=", ">=", "&&", "||", "<", ">", "!", "+", "?", ":", ".", ",", "(", ")", "[", "]",
        "{", "}", "-", "=",
    ];
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '#' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        let start = i;
        if c.is_ascii_digit() {
            let mut s = String::new();
            let mut float = false;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                if chars[i] == '.' {
                    if float || !chars.get(i + 1).is_some_and(char::is_ascii_digit) {
                        break;
                    }
                    float = true;
                }
                s.push(chars[i]);
                i += 1;
            }
            let value = s.parse::<f64>().map_err(|_| ExprError { offset: start, message: format!("「{s}」不是有效的数字") })?;
            out.push((Tok::Num(value, float), start));
            continue;
        }
        if c == '"' || c == '\'' {
            let quote = c;
            i += 1;
            let mut s = String::new();
            loop {
                let Some(&ch) = chars.get(i) else {
                    return Err(ExprError { offset: start, message: "字符串缺少结尾的引号".into() });
                };
                i += 1;
                if ch == quote {
                    break;
                }
                if ch == '\\' {
                    let Some(&escaped) = chars.get(i) else {
                        return Err(ExprError { offset: start, message: "字符串缺少结尾的引号".into() });
                    };
                    i += 1;
                    s.push(match escaped {
                        'n' => '\n',
                        't' => '\t',
                        other => other,
                    });
                } else {
                    s.push(ch);
                }
            }
            out.push((Tok::Str(s), start));
            continue;
        }
        if c.is_alphabetic() || c == '_' || c == '$' {
            let mut s = String::new();
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_' || (chars[i] == '$' && s.is_empty())) {
                s.push(chars[i]);
                i += 1;
            }
            out.push((Tok::Ident(s), start));
            continue;
        }
        let rest: String = chars[i..chars.len().min(i + 2)].iter().collect();
        let Some(op) = OPS.iter().find(|op| rest.starts_with(**op)) else {
            return Err(ExprError { offset: start, message: format!("不认识的符号「{c}」") });
        };
        if *op == "=" {
            return Err(ExprError { offset: start, message: "比较相等请写「==」".into() });
        }
        i += op.chars().count();
        out.push((Tok::Op(op), start));
    }
    out.push((Tok::End, chars.len()));
    Ok(out)
}

struct Parser {
    toks: Vec<(Tok, usize)>,
    at: usize,
}

impl Parser {
    fn peek(&self) -> &Tok {
        &self.toks[self.at].0
    }
    fn offset(&self) -> usize {
        self.toks[self.at].1
    }
    fn bump(&mut self) -> Tok {
        let tok = self.toks[self.at].0.clone();
        if self.at + 1 < self.toks.len() {
            self.at += 1;
        }
        tok
    }
    fn eat(&mut self, op: &str) -> bool {
        if matches!(self.peek(), Tok::Op(o) if *o == op) {
            self.bump();
            true
        } else {
            false
        }
    }
    fn expect(&mut self, op: &str, what: &str) -> Result<(), ExprError> {
        if self.eat(op) {
            Ok(())
        } else {
            Err(self.error(format!("这里缺少「{op}」（{what}）")))
        }
    }
    fn error(&self, message: String) -> ExprError {
        ExprError { offset: self.offset(), message }
    }
    fn expr(&mut self) -> Result<Ast, ExprError> {
        let condition = self.or()?;
        if self.eat("?") {
            let then = self.expr()?;
            self.expect(":", "条件 ? 甲 : 乙")?;
            let otherwise = self.expr()?;
            return Ok(Ast::Ternary(Box::new(condition), Box::new(then), Box::new(otherwise)));
        }
        Ok(condition)
    }
    fn or(&mut self) -> Result<Ast, ExprError> {
        let mut left = self.and()?;
        while self.eat("||") {
            left = Ast::Binary("||".into(), Box::new(left), Box::new(self.and()?));
        }
        Ok(left)
    }
    fn and(&mut self) -> Result<Ast, ExprError> {
        let mut left = self.compare()?;
        while self.eat("&&") {
            left = Ast::Binary("&&".into(), Box::new(left), Box::new(self.compare()?));
        }
        Ok(left)
    }
    fn compare(&mut self) -> Result<Ast, ExprError> {
        let left = self.add()?;
        for op in ["==", "!=", "<=", ">=", "<", ">"] {
            if self.eat(op) {
                let right = self.add()?;
                if let Tok::Op(next) = self.peek() {
                    if ["==", "!=", "<=", ">=", "<", ">"].contains(next) {
                        return Err(self.error("比较不能连写，请用 && 连接两次比较".into()));
                    }
                }
                return Ok(Ast::Binary(op.into(), Box::new(left), Box::new(right)));
            }
        }
        Ok(left)
    }
    fn add(&mut self) -> Result<Ast, ExprError> {
        let mut left = self.unary()?;
        loop {
            if self.eat("+") {
                left = Ast::Binary("+".into(), Box::new(left), Box::new(self.unary()?));
            } else if matches!(self.peek(), Tok::Op("-")) {
                // 引擎只有加法：「甲 - 数字」落成加上负数，减去变量不支持。
                let at = self.offset();
                self.bump();
                match self.unary()? {
                    Ast::Const(Value::Number(n)) => {
                        let negated = n.as_i64().map(|v| json!(-v)).or_else(|| n.as_f64().map(|v| json!(-v))).unwrap_or(Value::Null);
                        left = Ast::Binary("+".into(), Box::new(left), Box::new(Ast::Const(negated)));
                    }
                    _ => return Err(ExprError { offset: at, message: "只能减去一个数字（如 len(x) - 1）；名字里请用下划线代替「-」".into() }),
                }
            } else {
                return Ok(left);
            }
        }
    }
    fn unary(&mut self) -> Result<Ast, ExprError> {
        if self.eat("!") {
            return Ok(Ast::Not(Box::new(self.unary()?)));
        }
        if matches!(self.peek(), Tok::Op("-")) {
            let at = self.offset();
            self.bump();
            return match self.unary()? {
                Ast::Const(Value::Number(n)) => Ok(Ast::Const(n.as_i64().map(|v| json!(-v)).or_else(|| n.as_f64().map(|v| json!(-v))).unwrap_or(Value::Null))),
                _ => Err(ExprError { offset: at, message: "「-」只能写在数字前面；名字里请用下划线代替「-」".into() }),
            };
        }
        self.postfix()
    }
    fn postfix(&mut self) -> Result<Ast, ExprError> {
        let mut base = self.primary()?;
        loop {
            if self.eat(".") {
                match self.bump() {
                    Tok::Ident(name) => base = Ast::Field(Box::new(base), name),
                    Tok::Num(n, false) => base = Ast::Index(Box::new(base), Box::new(Ast::Const(json!(n as u64)))),
                    _ => return Err(self.error("「.」后面要写字段名".into())),
                }
            } else if self.eat("[") {
                let key = self.expr()?;
                self.expect("]", "取下标")?;
                base = match key {
                    Ast::Const(Value::String(name)) => Ast::Field(Box::new(base), name),
                    other => Ast::Index(Box::new(base), Box::new(other)),
                };
            } else {
                return Ok(base);
            }
        }
    }
    fn primary(&mut self) -> Result<Ast, ExprError> {
        let offset = self.offset();
        match self.bump() {
            Tok::Num(n, float) => Ok(Ast::Const(if float { json!(n) } else { json!(n as i64) })),
            Tok::Str(s) => Ok(Ast::Const(json!(s))),
            Tok::Ident(name) => match name.as_str() {
                "true" => Ok(Ast::Const(json!(true))),
                "false" => Ok(Ast::Const(json!(false))),
                "null" => Ok(Ast::Const(Value::Null)),
                _ if self.eat("(") => {
                    let mut args = Vec::new();
                    if !self.eat(")") {
                        loop {
                            args.push(self.expr()?);
                            if self.eat(")") {
                                break;
                            }
                            self.expect(",", "参数之间用逗号分隔")?;
                            if self.eat(")") {
                                break;
                            }
                        }
                    }
                    Ok(Ast::Call(name, args))
                }
                _ => Ok(Ast::Name(name)),
            },
            Tok::Op("(") => {
                let inner = self.expr()?;
                self.expect(")", "括号要成对")?;
                Ok(inner)
            }
            Tok::Op("[") => {
                let mut items = Vec::new();
                while !self.eat("]") {
                    items.push(self.expr()?);
                    if !self.eat(",") {
                        self.expect("]", "数组要用「]」结尾")?;
                        break;
                    }
                }
                Ok(Ast::Array(items))
            }
            Tok::Op("{") => {
                let mut fields = Vec::new();
                while !self.eat("}") {
                    let key = match self.bump() {
                        Tok::Ident(k) | Tok::Str(k) => k,
                        _ => return Err(self.error("对象里要写「键: 值」".into())),
                    };
                    self.expect(":", "对象里要写「键: 值」")?;
                    fields.push((key, self.expr()?));
                    if !self.eat(",") {
                        self.expect("}", "对象要用「}」结尾")?;
                        break;
                    }
                }
                Ok(Ast::Object(fields))
            }
            Tok::End => Err(ExprError { offset, message: "表达式不完整".into() }),
            Tok::Op(op) => Err(ExprError { offset, message: format!("这里不能出现「{op}」") }),
        }
    }
}

pub fn parse(text: &str) -> Result<Ast, ExprError> {
    if text.trim().is_empty() {
        return Err(ExprError { offset: 0, message: "表达式是空的".into() });
    }
    let mut parser = Parser { toks: lex(text)?, at: 0 };
    let ast = parser.expr()?;
    if *parser.peek() != Tok::End {
        return Err(parser.error("表达式在这里之后还有多余的内容".into()));
    }
    Ok(ast)
}

/// 名字的落点：哪些是节点 / 调用步骤（取 `/latest/<名字>`）。
pub trait Names {
    fn is_result(&self, name: &str) -> bool;
    fn suggestions(&self) -> Vec<String>;
}

/// 编译期能看出的引用，供调用方做字段核对（如结果里没声明的字段）。
#[derive(Debug, Clone, PartialEq)]
pub enum Reference {
    Var(String),
    Result { name: String, field: Option<String> },
}

pub struct Lowered {
    pub value: Value,
    pub references: Vec<Reference>,
    /// `结果.字段 == "字面量"` 形式的比较（供核对枚举取值）。
    pub comparisons: Vec<(String, String, String)>,
}

const ROOTS: [(&str, &str); 6] = [
    ("vars", "/vars"),
    ("input", "/vars/input"),
    ("item", "/item"),
    ("index", "/index"),
    ("previous", "/previous"),
    ("latest", "/latest"),
];

fn escape(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

struct Lowering<'a> {
    names: &'a dyn Names,
    references: Vec<Reference>,
    comparisons: Vec<(String, String, String)>,
}

impl Lowering<'_> {
    /// 纯路径（名字 + 字段 / 常量下标）落成 JSON 指针。
    fn pointer(&mut self, ast: &Ast) -> Result<Option<(String, Vec<String>)>, String> {
        Ok(match ast {
            Ast::Name(name) => {
                if let Some((_, root)) = ROOTS.iter().find(|(n, _)| n == name) {
                    Some((root.to_string(), vec![name.clone()]))
                } else if self.names.is_result(name) {
                    Some((format!("/latest/{}", escape(name)), vec!["".into(), name.clone()]))
                } else {
                    let mut known: Vec<String> = ROOTS.iter().map(|(n, _)| n.to_string()).collect();
                    known.extend(self.names.suggestions());
                    return Err(format!("不认识的名字「{name}」。可以用的有：{}", known.join("、")));
                }
            }
            Ast::Field(base, field) => self.pointer(base)?.map(|(pointer, mut chain)| {
                chain.push(field.clone());
                (format!("{pointer}/{}", escape(field)), chain)
            }),
            Ast::Index(base, index) => match index.as_ref() {
                Ast::Const(Value::Number(n)) if n.as_u64().is_some() => {
                    self.pointer(base)?.map(|(pointer, mut chain)| {
                        chain.push(n.to_string());
                        (format!("{pointer}/{n}"), chain)
                    })
                }
                _ => None,
            },
            _ => None,
        })
    }

    fn note(&mut self, chain: &[String]) {
        match chain {
            [root, name, rest @ ..] if root == "vars" => {
                let _ = rest;
                self.references.push(Reference::Var(name.clone()));
            }
            [empty, name, rest @ ..] if empty.is_empty() => self.references.push(Reference::Result {
                name: name.clone(),
                field: rest.first().cloned(),
            }),
            _ => {}
        }
    }

    fn lower(&mut self, ast: &Ast) -> Result<Value, String> {
        if let Some((pointer, chain)) = self.pointer(ast)? {
            self.note(&chain);
            return Ok(json!({ "path": pointer }));
        }
        Ok(match ast {
            Ast::Const(value) => value.clone(),
            Ast::Array(items) => {
                let values = items
                    .iter()
                    .map(constant)
                    .collect::<Option<Vec<_>>>()
                    .ok_or("数组里只能写常量；需要组合结果请用 merge 或对象")?;
                Value::Array(values)
            }
            Ast::Object(fields) => {
                if let Some(value) = constant(ast) {
                    json!({ "literal": value })
                } else {
                    let mut map = Map::new();
                    for (key, value) in fields {
                        map.insert(key.clone(), self.lower(value)?);
                    }
                    json!({ "object": map })
                }
            }
            Ast::Name(_) => unreachable!("names lower to paths"),
            Ast::Field(base, field) => json!({ "get": [self.lower(base)?, field] }),
            Ast::Index(base, index) => json!({ "index": [self.lower(base)?, self.lower(index)?] }),
            Ast::Not(inner) => json!({ "not": self.lower(inner)? }),
            Ast::Ternary(condition, then, otherwise) => json!({ "if": {
                "condition": self.lower(condition)?,
                "then": self.lower(then)?,
                "else": self.lower(otherwise)?,
            }}),
            Ast::Binary(op, left, right) => match op.as_str() {
                "&&" | "||" => {
                    let key = if op == "&&" { "all" } else { "any" };
                    let mut parts = Vec::new();
                    for side in [left, right] {
                        let value = self.lower(side)?;
                        match (side.as_ref(), value.get(key).and_then(Value::as_array)) {
                            (Ast::Binary(inner, _, _), Some(list)) if inner == op => parts.extend(list.iter().cloned()),
                            _ => parts.push(value),
                        }
                    }
                    json!({ key: parts })
                }
                "==" | "!=" => {
                    for (path, literal) in [(left, right), (right, left)] {
                        if let (Some((_, chain)), Ast::Const(Value::String(text))) = (self.pointer(path)?, literal.as_ref()) {
                            if let [empty, name, field, ..] = chain.as_slice() {
                                if empty.is_empty() {
                                    self.comparisons.push((name.clone(), field.clone(), text.clone()));
                                }
                            }
                        }
                    }
                    json!({ if op == "==" { "eq" } else { "ne" }: [self.lower(left)?, self.lower(right)?] })
                }
                "<" => json!({ "lt": [self.lower(left)?, self.lower(right)?] }),
                ">" => json!({ "lt": [self.lower(right)?, self.lower(left)?] }),
                "<=" => json!({ "not": { "lt": [self.lower(right)?, self.lower(left)?] } }),
                ">=" => json!({ "not": { "lt": [self.lower(left)?, self.lower(right)?] } }),
                "+" => json!({ "add": [self.lower(left)?, self.lower(right)?] }),
                _ => unreachable!(),
            },
            Ast::Call(name, args) => self.call(name, args)?,
        })
    }

    fn call(&mut self, name: &str, args: &[Ast]) -> Result<Value, String> {
        let arity = |n: usize| {
            if args.len() == n {
                Ok(())
            } else {
                Err(format!("{name}(…) 需要 {n} 个参数，这里写了 {} 个", args.len()))
            }
        };
        Ok(match name {
            "len" => {
                arity(1)?;
                json!({ "len": self.lower(&args[0])? })
            }
            "nonempty" => {
                arity(1)?;
                json!({ "nonempty": self.lower(&args[0])? })
            }
            "get" => {
                arity(2)?;
                json!({ "get": [self.lower(&args[0])?, self.lower(&args[1])?] })
            }
            "merge" => {
                if args.len() < 2 {
                    return Err("merge(…) 至少要两个参数".into());
                }
                json!({ "merge": args.iter().map(|a| self.lower(a)).collect::<Result<Vec<_>, _>>()? })
            }
            "every" => {
                arity(2)?;
                json!({ "every": { "items": self.lower(&args[0])?, "predicate": self.lower(&args[1])? } })
            }
            "items_valid" => {
                arity(3)?;
                let fields = match constant(&args[1]) {
                    Some(Value::Array(items)) if items.iter().all(Value::is_string) => Value::Array(items),
                    _ => return Err("items_valid 的第二个参数要写成字段名数组，如 [\"id\", \"title\"]".into()),
                };
                let Some(Value::String(unique)) = constant(&args[2]) else {
                    return Err("items_valid 的第三个参数要写唯一字段名，如 \"id\"".into());
                };
                json!({ "itemsValid": { "items": self.lower(&args[0])?, "fields": fields, "unique": unique } })
            }
            other => {
                return Err(format!(
                    "没有「{other}」这个函数。可用的函数：len、nonempty、merge、every、items_valid、get"
                ));
            }
        })
    }
}

fn constant(ast: &Ast) -> Option<Value> {
    match ast {
        Ast::Const(value) => Some(value.clone()),
        Ast::Array(items) => items.iter().map(constant).collect::<Option<Vec<_>>>().map(Value::Array),
        Ast::Object(fields) => {
            let mut map = Map::new();
            for (key, value) in fields {
                map.insert(key.clone(), constant(value)?);
            }
            Some(Value::Object(map))
        }
        _ => None,
    }
}

pub fn lower(ast: &Ast, names: &dyn Names) -> Result<Lowered, String> {
    let mut lowering = Lowering { names, references: vec![], comparisons: vec![] };
    let value = lowering.lower(ast)?;
    Ok(Lowered { value, references: lowering.references, comparisons: lowering.comparisons })
}

/// 只允许纯路径（会话归属 `session_scope` 用）：落成 JSON 指针字符串。
pub fn pointer_of(ast: &Ast, names: &dyn Names) -> Result<String, String> {
    let mut lowering = Lowering { names, references: vec![], comparisons: vec![] };
    lowering
        .pointer(ast)?
        .map(|(pointer, _)| pointer)
        .ok_or_else(|| "这里只能写路径，如 vars.currentAr.id".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Known;
    impl Names for Known {
        fn is_result(&self, name: &str) -> bool {
            ["review", "plan"].contains(&name)
        }
        fn suggestions(&self) -> Vec<String> {
            vec!["review".into(), "plan".into()]
        }
    }

    fn compile(text: &str) -> Value {
        lower(&parse(text).unwrap(), &Known).unwrap().value
    }

    #[test]
    fn paths_and_comparisons() {
        assert_eq!(
            compile(r#"review.decision == "pass" && nonempty(review.report)"#),
            json!({"all":[{"eq":[{"path":"/latest/review/decision"},"pass"]},{"nonempty":{"path":"/latest/review/report"}}]})
        );
        assert_eq!(compile("input.requirement"), json!({"path":"/vars/input/requirement"}));
        assert_eq!(compile("vars.ars[vars.i].id"), json!({"get":[{"index":[{"path":"/vars/ars"},{"path":"/vars/i"}]},"id"]}));
        assert_eq!(compile("vars.任务[0]"), json!({"path":"/vars/任务/0"}));
    }

    #[test]
    fn operators() {
        assert_eq!(compile("vars.n < 3"), json!({"lt":[{"path":"/vars/n"},3]}));
        assert_eq!(compile("vars.n >= 3"), json!({"not":{"lt":[{"path":"/vars/n"},3]}}));
        assert_eq!(compile("vars.n + 1"), json!({"add":[{"path":"/vars/n"},1]}));
        assert_eq!(compile("len(vars.xs) - 1"), json!({"add":[{"len":{"path":"/vars/xs"}},-1]}));
        assert_eq!(compile("a || b || c".replace(['a', 'b', 'c'], "plan").as_str()), json!({"any":[{"path":"/latest/plan"},{"path":"/latest/plan"},{"path":"/latest/plan"}]}));
        assert_eq!(
            compile("index == 0 ? vars.a : previous.b"),
            json!({"if":{"condition":{"eq":[{"path":"/index"},0]},"then":{"path":"/vars/a"},"else":{"path":"/previous/b"}}})
        );
        assert_eq!(compile(r#"{status: "ready"}"#), json!({"literal":{"status":"ready"}}));
        assert_eq!(compile("merge(vars, {task: item})"), json!({"merge":[{"path":"/vars"},{"object":{"task":{"path":"/item"}}}]}));
    }

    #[test]
    fn readable_errors() {
        let error = lower(&parse("revew.decision").unwrap(), &Known).err().unwrap();
        assert!(error.contains("不认识的名字「revew」"), "{error}");
        assert!(parse("a = 1").unwrap_err().message.contains("=="));
        assert!(parse("vars.a - vars.b").unwrap_err().message.contains("只能减去一个数字"));
        assert!(parse("plan.x == ").unwrap_err().message.contains("不完整"));
        assert!(lower(&parse("foo(1)").unwrap(), &Known).err().unwrap().contains("没有「foo」"));
    }
}
