# Java语言编码规范&约束 v1.0

> **使用指南**
> -进行Java编码时，需要遵循以下规范
> -遇到的问题可以实时同步进该文档，保证下次编码过程中不重复犯错

## 📋 文档元数据
```yaml
document:
  type: "Java语言编码规范&约束"
  desc: "本文档描述的规范需要在编码过程中严格遵守"
```

## Java语言编码规范&约束

### 1. 控制语句（Control Statements）
- ✅ **switch 语句要有 default 分支**
- ❌ **禁止 switch 语句中直接嵌套 switch**
---
### 2. 方法（Methods）
- ❌ **禁止使用已标注为 @Deprecated 的方法、类、类的属性等**
- ❌ **不能把方法的参数当做临时变量**
- ✅ **对于返回数组或者容器的方法，应返回长度为0的数组或者容器，代替返回null**
- ✅ **使用Optional代替null作为返回值或者可能的缺失值**
---
### 3. 类、接口与面向对象编程（Classes, Interfaces and OOP）
- ❌ **不要在父类的构造方法中调用可能被子类覆写的方法**
- ❌ **禁止在无关的变量或无关的概念之间重用名字**：避免隐藏（hide）、遮蔽（shadow）和遮掩（obscure）
- ✅ **覆写 equals 方法时，要同时覆写 hashCode 方法**
---
### 4. 异常处理（Exception Handling）
- ✅ **具体异常优先**：捕获具体的异常而非 `Exception`，除非在框架中属于“公共服务”性质的“兜底”处理，例如事件循环、线程结束时的异常处理。
- ✅ **异常必须处理**：禁止空 catch 块
- ✅ **使用自定义业务异常**：定义 `BusinessException`、`SystemException`
- ❌ **禁止吞没异常**：catch 后不重新抛出
- ❌ **禁止使用 `e.printStackTrace()`**：使用日志框架
- ✅ **方法抛出的异常，应该与本身的抽象层次相对应** ：低层异常应转换为业务异常
- ✅ **防止通过异常泄露敏感信息** ：异常消息中不应包含密码、密钥、会话id、文件路径等敏感信息

| 可能泄漏敏感信息的异常                                 | 信息泄露或威胁描述                 |
|---------------------------------------------|---------------------------|
| java.io.FileNotFoundException               | 	泄露文件系统结构和文件名列举           | 
| java.util.jar.JarException	                 | 泄露文件系统结构                  | 
| java.util.MissingResourceException          | 	资源列举                     | 
| java.security.acl.NotOwnerException         | 	所有人列举                    | 
| java.util.ConcurrentModificationException   | 	可能提供线程不安全的代码信息           | 
| javax.naming.InsufficientResourcesException | 	服务器资源不足（可能有利于DoS攻击）      | 
| java.net.BindException	                     | 当不信任客户端能够选择服务器端口时造成开放端口列举 | 
| java.lang.OutOfMemoryError	                 | DoS                       | 
| java.lang.StackOverflowError                | 	DoS                      | 
| java.sql.SQLException                       | 	数据库结构，用户名列举              | 

- ✅ **业务异常**：捕获并转换为用户友好的错误消息
- ✅ **系统异常**：记录日志并返回通用错误消息
- ✅ **可恢复异常**：提供重试机制
- ❌ **禁止使用 return、break、continue 或抛出异常使 finally 块非正常结束** 
---
### 5. 并发安全（Concurrency Safety）
- ✅ **共享变量使用 `volatile`**：保证可见性
- ✅ **原子操作使用 `Atomic` 类**：`AtomicInteger`、`AtomicReference`
- ✅ **使用同步机制**：`synchronized`、`Lock`
- ✅ **使用线程安全集合**：`ConcurrentHashMap`、`CopyOnWriteArrayList`
- ❌ **禁止在多线程环境下使用非线程安全的集合**：`HashMap`、`ArrayList`
- ✅ **对共享变量做同步访问控制时需避开同步陷阱**：确保锁的正确性和一致性
- ✅ **在异常条件下，保证释放已持有的锁**：使用 finally 块释放锁
- ❌ **禁止使用不正确形式的双重检查锁**：必须使用 volatile 修饰单例实例
- ❌ **禁止使用非线程安全的方法来覆写线程安全的方法**：保持线程安全的一致性
- ✅ **创建新线程时必须指定线程名**：便于调试和监控
- ✅ **使用 Thread 对象的 setUncaughtExceptionHandler 方法注册未捕获异常处理者**：避免线程静默退出
- ❌ **禁止使用 Thread.stop() 来终止线程**：使用中断机制或标志位
- ✅ **线程池中的任务结束后必须清理其自定义的 ThreadLocal 变量**：防止内存泄漏，threadLocal.remove()
---
### 6. 输入输出（Input Output）
- ✅ **使用外部数据构造的文件路径前必须进行校验，校验前必须对文件路径进行规范化处理**：防止路径遍历攻击
- ✅ **解压文件时必须进行安全检查，避免解压 DOS 和路径遍历的问题**：限制解压文件数量和大小
- ✅ **临时文件使用完毕必须及时删除**：使用 DELETE_ON_CLOSE 选项
---
### 7. 序列化（Serialization）
- ✅ **序列化对象中的 HashMap、HashSet 或 HashTable 等集合禁止包含对象自身的引用**：防止序列化异常
- ❌ **禁止直接序列化指向系统资源的信息**：如文件句柄、数据库连接等。系统资源用transient标记
- ❌ **禁止序列化非静态的内部类**：内部类会隐式持有外部类引用
- ✅ **序列化操作要防止敏感信息泄露**：标记敏感字段为 transient
- ✅ **防止反序列化被利用来绕过构造方法中的安全操作**：实现 readObject 方法进行校验
- ❌ **禁止直接将外部数据进行反序列化**：防止反序列化攻击。推荐：使用白名单和校验
---
### 8. 日志（Logging）
- ✅ **记录日志应该使用 Facade 模式的日志框架**
- ✅ **日志使用英文** 
- ❌ **禁止直接使用外部数据记录日志**
- ❌ **禁止在日志中记录口令、密钥、会话id等敏感信息** 
---
### 9. 性能考虑（Performance Considerations）
#### 9.1 字符串处理（String Processing）
- ✅ **使用 `StringBuilder` 拼接字符串**
- ❌ **禁止在循环中创建 `String` 对象**
#### 9.2 集合使用（Collection Usage）
- ✅ **指定集合初始容量**：避免扩容开销
- ✅ **根据场景选择合适的集合**：
    - `ArrayList`：随机访问多
    - `LinkedList`：插入删除多
    - `HashSet`：需要去重
    - `TreeSet`：需要排序
- ❌ **禁止在循环中调用 `size()`**：提前保存
- ✅ **使用System.arraycopy()或Arrays.copyOf()进行数组复制**
#### 9.3 对象创建（Object Creation）
- ✅ **重用对象**：使用对象池、缓存
- ✅ **使用基本类型**：`int` 而非 `Integer`（除非需要 null）
#### 9.4 数据库查询（Database Query）
- ✅ **使用索引**：避免全表扫描
- ✅ **避免 N+1 查询**：使用 JOIN 或批量查询
- ✅ **分页查询**：避免一次性加载大量数据
- ❌ **禁止 `SELECT *`**：只查询需要的字段
---
### 10. 资源管理（Resource Management）
- ✅ **使用 try-with-resources**
- ✅ **及时关闭资源**：文件、数据库连接、网络连接等
- ✅ **及时释放连接**：在 finally 块中关闭
- ✅ **使用事务**
- ✅ **使用线程池**：`ExecutorService` 而非直接创建线程
- ✅ **正确关闭线程池**：调用 `shutdown()` 或 `shutdownNow()`
- ❌ **禁止直接创建线程**：避免 `new Thread()`
---
### 11. 安全性（Security）
#### 11.1 输入验证（Input Validation）
- ✅ **验证所有输入**：参数、用户输入、配置
- ✅ **使用正则表达式验证格式**：邮箱、电话等
- ✅ **白名单优先**：而非黑名单
- ❌ **禁止信任客户端输入**
- ❌ **禁止直接使用外部数据来拼接 SQL 语句**：使用参数化查询
- ❌ **禁止直接使用外部数据构造格式化字符串**：防止格式化字符串攻击
- ❌ **禁止直接向 Runtime.exec() 方法或 java.lang.ProcessBuilder 类传递外部数据**：防止命令注入
- ❌ **禁止直接使用外部数据来拼接 XML** (G.EDV.04)：防止 XML 注入
- ✅ **防止解析来自外部的 XML 导致的外部实体（XML External Entity）攻击**：禁用 DTD 和外部实体
- ✅ **防止解析来自外部的 XML 导致的内部实体扩展（XML Entity Expansion）攻击**：限制实体扩展深度
- ❌ **禁止使用不安全的 XSLT 转换 XML 文件**：禁用 XSLT 的危险功能
- ✅ **正则表达式要简单，防止 ReDos 攻击**：避免复杂的回溯
- ❌ **禁止直接使用外部数据作为反射操作中的类名/方法名**：防止反射攻击
- ❌ **禁止直接使用外部数据动态创建的模板**：防止模板注入
- ❌ **禁止直接使用外部数据拼接表达式**：防止表达式注入
#### 11.2 SQL 注入防护（SQL Injection Prevention）
- ✅ **使用参数化查询**（PreparedStatement）
- ❌ **禁止字符串拼接 SQL**
#### 11.3 敏感信息保护（Sensitive Information Protection）
敏感信息：密码、公钥、私钥、会话id、个人隐私
- ✅ **敏感信息加密存储**
- ✅ **禁止日志输出敏感信息**
- ❌ **禁止明文存储密码**
- ✅ **进行安全检查的方法必须声明为 private 或 final** ：防止被子类覆写
#### 11.4 平台安全（Platform Security）
- ✅ **安全场景下必须使用密码学意义上的安全随机数**：使用 SecureRandom
- ✅ **不用的代码段包括 import 语句，直接删除，不要注释掉**
- ❌ **禁止代码中包含公网地址**：使用配置文件或环境变量
---
### 12. 代码结构（Code Structure）
#### 12.1 类结构（Class Structure）
- ✅ **类长度不超过 500 行**（理想 200-300 行）
- ✅ **成员变量顺序**：public → protected → private
- ✅ **方法顺序**：构造方法 → public 方法 → protected 方法 → private 方法
- ✅ **遵循单一职责原则**：一个类只做一件事
#### 12.2 方法结构（Method Structure）
- ✅ **方法长度不超过 50 行**（理想 20-30 行）
- ✅ **参数数量不超过 5 个**（超过时使用对象封装）
- ✅ **单一职责**：一个方法只做一件事
- ✅ **圈复杂度不超过 10**（嵌套层级不超过 3 层）
#### 12.3 代码组织（Code Organization）
- ✅ **使用分层架构**：business → repository → DAO → Entity
- ✅ **接口与实现分离**：定义接口，提供实现类
- ✅ **使用包按功能划分**：而非按层次划分
---
### 13. 可读性（Readability）
#### 13.1 注释规范（Comment Standards）
- ✅ **类注释**：包含类的作用、作者、日期
  ```java
  /**
   * 用户服务类，提供用户相关的业务逻辑处理
   *
   * @author zhangsan
   * @since 2024-01-01
   */
  public class UserService { }
  ```
- ✅ **方法注释**：使用中文描述，包含方法作用、参数说明、返回值说明、异常说明
  ```java
  /**
   * 根据用户ID查询用户信息
   *
   * @param userId 用户ID
   * @return 用户信息，不存在返回null
   * @throws IllegalArgumentException 当userId为null或小于0时抛出
   */
  public User getUserById(Long userId) { }
  ```
- ✅ **复杂逻辑注释**：解释"为什么"而非"是什么"
- ❌ **禁止注释显而易见的代码**：禁止 `// 设置年龄` 这种无用注释
- ✅ **版权信息**: java文件头部必须有版本信息，`2022-2025`第一个数字为创建文件的年份，第二个数字为最后一次修改文件的年份；文件发生变动时，自动更新第二个数字为当前年份。。
  ```java
  // ✅ 强制
  /*
  * Copyright (c) Huawei Technologies Co., Ltd. 2022-2025. All rights reserved.
  */
  ```
#### 13.2 逻辑清晰度（Logic Clarity）
- ✅ **使用有意义的布尔表达式**：`if (isValid)` 而非 `if (flag)`
- ❌ **禁止使用 `?:` 嵌套超过 2 层**
- ✅ **实体类使用lombok**: 避免直接输出set/get方法；使用@Data和@ToString时，排除包含敏感信息的字段
### 14. 设计原则（Design Principles）
#### 14.1 SOLID 原则
- ✅ **单一职责原则（SRP）**：一个类只做一件事
- ✅ **开闭原则（OCP）**：对扩展开放，对修改关闭
- ✅ **里氏替换原则（LSP）**：子类可以替换父类
- ✅ **接口隔离原则（ISP）**：接口应该小而专一
- ✅ **依赖倒置原则（DIP）**：依赖抽象而非具体实现
#### 14.2 设计模式（Design Patterns）
- ✅ **适当使用设计模式**：单例、工厂、策略、观察者、门面等
- ❌ **禁止滥用设计模式**：简单场景不需要复杂模式
#### 14.3 代码复用（Code Reuse）
- ✅ **使用工具类**：`org.apache.commons.lang3.StringUtils`、`org.apache.commons.collections.CollectionUtils`
- ✅ **使用继承和组合**：复用代码
- ❌ **禁止复制粘贴代码**：重复超过 2 次必须提取
---

## Java语言测试用例规范&约束
> **说明：** Java语言中测试用例需要遵守的规范放于此

### 1. 测试覆盖率（Test Coverage）
#### 1.1 覆盖率指标
- ✅ **行覆盖率**（Line Coverage）：目标 ≥80%
- ✅ **分支覆盖率**（Branch Coverage）：目标 ≥70%
- ✅ **方法覆盖率**（Method Coverage）：目标 ≥90%
- ✅ **类覆盖率**（Class Coverage）：目标 ≥90%
#### 1.2 关键模块覆盖率
- ✅ **核心业务逻辑**：覆盖率 ≥95%
- ✅ **公共 API**：覆盖率 ≥90%
- ✅ **工具类**：覆盖率 ≥90%
- ✅ **数据访问层**：覆盖率 ≥80%
- 🟡 **配置类**：覆盖率 ≥60%（可适当降低）
---
### 3. 测试质量（Test Quality）
#### 3.1 测试用例完整性
- ✅ **正常场景**（Happy Path）：测试正常业务流程
- ✅ **边界条件**（Boundary Cases）：测试边界值、空值、极值
- ✅ **异常场景**（Exception Cases）：测试异常处理逻辑
- ✅ **并发场景**（Concurrency Cases）：测试多线程安全性
#### 3.2 测试独立性
- ✅ **测试隔离**：每个测试方法相互独立，不依赖执行顺序
- ✅ **数据隔离**：每个测试使用独立的测试数据，不共享状态
- ✅ **环境隔离**：测试不依赖外部环境（数据库、网络）
- ❌ **禁止测试间依赖**：避免测试方法间有隐式依赖
#### 3.3 测试可读性
- ✅ **测试方法名清晰**：
  - 三段式格式`test_{方法}_when_{场景}_then_{预期结果}` 格式
  - 四段式格式`test_{方法}_given_{输入数据}_when_{场景}_then_{预期结果}` 格式
- ✅ **测试逻辑清晰**：使用 Given-When-Then 模式
- ✅ **注释必要**：复杂测试添加注释说明，注释使用中文
- ❌ **禁止魔法数字**：使用常量或变量
---
### 4. 测试断言质量（Test Assertion Quality）
- ✅ **断言所有关键结果**：验证方法的返回值、副作用
- ✅ **断言异常**：使用 `@Test(expected)` 或 `assertThrows`
- ✅ **断言集合内容**：验证集合的大小、元素
- ❌ **禁止空断言**
- ✅ **使用精确断言**：`assertEquals` 而非 `assertTrue`
- ❌ **禁止模糊断言**：避免 `assertTrue(result)` 这种无意义的断言
- ✅ **断言工具使用JUnit 5**
---
### 5. Mock使用（Mock Usage）
- ✅ **Mock 框架使用Mockito**
- ❌ **禁止 Mock 被测试类**：只 Mock 依赖
---
### 6. 测试数据管理（Test Data Management）
- ✅ **使用 Builder 模式**：简化测试对象创建
- ✅ **使用测试数据工厂**：统一管理测试数据
- ✅ **使用 @Before 初始化**：在测试方法前准备数据
- ❌ **禁止硬编码测试数据**：使用常量或工厂方法
- ✅ **使用 @After 清理**：测试方法后清理数据
- ✅ **使用 @BeforeClass 和 @AfterClass**：类级别的初始化和清理
- ✅ **使用事务回滚**：数据库测试使用 `@Transactional` + `@Rollback`
- ❌ **禁止测试数据污染**：确保测试后数据恢复原状
---
## 项目级规范&约束
> **说明：** 项目级基本编码规范放于此