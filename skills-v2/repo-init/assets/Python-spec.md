# Python语言编码规范&约束模板

> **使用指南**
> -进行编码时，需要遵循以下规范
> -遇到的问题可以实时同步进该文档，保证下次编码过程中不重复犯错

## 📋 文档元数据
```yaml
document:
  type: "***语言编码规范&约束"
  desc: "本文档描述的规范需要在编码过程中严格遵守"
```



## Python语言编码规范&约束

### 格式

#### ✅ 版权信息

- 文件头注释应放在模块文档字符串之前，应包含版权许可信息。
- 版权许可信息放在shebang和文件编码声明之后。

#### ✅ 导入

- 导入部分(imports)应该按照标准库、第三方库、应用程序自定义模块的顺序排列导入。
- 导入部分(imports)应位于文件的顶端，置于模块注释和文档字符串之后，模块全局变量和常量声明之前。
- 如果文件中定义了类似__all__、__version__这种全局变量（以两个下划线开头、以两个下划线结尾），那么导入部分应该放在这类定义的后面，但__future__模块的导入例外，__future__模块的导入必须放在文档字符串之后，其他内容之前。

内容及格式如下：

【正例】(中文版)

```Python
#!/usr/bin/python3.7
# -*- coding: utf-8 -*-

"""
功 能：这是一个模块文档字符串的总体描述。
"""

from __future__ import print_function

__all__ = ['hello', 'world']
__version__ = 'V1.0'

import os
import sys

from oslo_config import cfg
from oslo_log import log as logging

from cinder import context
from cinder import db
```

【正例】(英文版)

```Python
#!/usr/bin/python3.7
# -*- coding: utf-8 -*-

"""
Function: This is an overall description of the module documentation string.
"""

from __future__ import print_function

__all__ = ['hello', 'world']
__version__ = 'V1.0'

import os
import sys

from oslo_config import cfg
from oslo_log import log as logging

from cinder import context
from cinder import db
```

####  ✅函数注释

- **强制要求**：所有 `public`（公开）函数必须包含注释。
- **可选要求**：`private`（私有，即以 `_` 开头，如 `_internal_func`）函数建议添加注释，若逻辑简单可省略。

```python
def func(param1, param2):
    """
    函数的描述信息
    :param param1: 参数1描述
    :param param2: 参数2描述
    :return : 返回值描述
    """
     # 函数体代码
    pass
```

#### ❌行宽不宜过长

**【描述】**
行宽包含代码以及注释等，行宽不宜过长，否则不利于阅读。每行字符数不要超过 120 个；

**【例外】**
对于换行导致内容截断，不方便查找、拷贝的字符串（如长URL、命令行等）可以不换行。

### 命名 

#### ✅使用统一的命名风格

**常用标识符类型的命名风格推荐表：**

| 类别                       | 公有               | 私有                                                         |
| -------------------------- | ------------------ | ------------------------------------------------------------ |
| Modules                    | lower_with_under   | _lower_with_under                                            |
| Packages                   | lower_with_under   |                                                              |
| Classes                    | CapWords           |                                                              |
| Exceptions                 | CapWords           |                                                              |
| Functions                  | lower_with_under() | _lower_with_under()                                          |
| Global/Class Constants     | CAPS_WITH_UNDER    | _CAPS_WITH_UNDER                                             |
| Global/Class Variables     | lower_with_under   | _lower_with_under                                            |
| Instance Variables         | lower_with_under   | _lower_with_under or __lower_with_under (当需要名字修饰时）  |
| Method Names               | lower_with_under() | _lower_with_under() or __lower_with_under() (当需要名字修饰时) |
| Function/Method Parameters | lower_with_under   |                                                              |
| Local Variables            | lower_with_under   |                                                              |

### 类与面向对象

#### ✅ 类的方法建议统一按照一种规则进行排列

按照业界约定俗成的顺序来组织类的方法，按照如下的顺序组织：

1. `__new__`静态方法
2. `__init__`方法
3. `__post_init__`方法
4. 其它魔法函数
5. `@property`修饰的对象属性（包含被修饰的对象为保护方法或私有方法，放在尾部）
6. `@staticmethod`修饰的静态方法（包含被修饰的对象为保护方法或私有方法，放在尾部）
7. `@classmethod`修饰的类方法（包含被修饰的对象为保护方法或私有方法，放在尾部）
8. 普通方法
9. 保护方法或私有方法

### 变量作用域

#### ❌禁止覆盖外部作用域中的标识符

禁止出现当前局部作用域遮盖更外层作用域中的标识符，给阅读者带来困扰，无法清晰知道在使用哪个变量。

**【反例】**

```Python
_global = 1


def test():
    _global = 2  # 不符合, 更外层作用域（模块命名空间）中变量被遮盖
    ...
```

✅ 类的方法不需要访问实例时，定义为staticmethod或classmethod

在类的方法不需要访问实例时，根据以下场景将方法定义为类方法或静态方法：
1.在不需要访问实例，需要访问类属性或方法时，使用`@classmethod`将方法定义为类方法；
2.在不需要访问实例也不需要访问类属性或方法时，使用`@staticmethod`将方法定义为静态方法。

**【正例】**

```python
class MyClass:
    class_attr = "MyClass.class_attr"

    @staticmethod
    def add(a: int, b: int) -> int:
        return a + b

    @classmethod
    def refresh_class_attr(cls, string_value: str):
        cls.class_attr = string_value



if __name__ == '__main__':
    MyClass.refresh_class_attr("Refreshed MyClass.class_attr")
    print(MyClass.class_attr)  # "Refreshed MyClass.class_attr"
    print(MyClass.add(1, 2))  # 3

```

**【例外】**
1.在子类重写父类实例方法时，如果不需要访问实例也不需要访问类属性或方法时，依照里氏替换设计原则，子类的方法可以保持为实例方法。

2.抽象类的abstractmethod可以不遵循，但是，如果要约束接口函数必须为静态方法或类方法时，需要加对应的staticmethod或classmethod装饰器限制异常处理

#### ❌避免抑制或忽略异常

当一段代码可能发生异常时，需要明确对这些异常的处理策略，包括但不限于重置状态、填充默认值、重试、返回错误等。
编码时应尽量避免捕获一个异常但什么都不做的情况，抑制或忽略异常很可能丢掉关键的错误和应对，对程序的稳定运行产生风险。

**【反例】**

```python
try:
    ...
except CertainException:  # 没有对异常做出相应的处理，存在风险
    pass

```

**【反例】**

```python
def get_input_integer():
    while True:
        try:
            i = input('Please enter an integer: ')
            check_integer(i)
        except ValueError:
            pass  # 这里看似合理，实际上在捕获异常后需要给用户足够的错误信息

    return i

```

**【正例】**
捕获异常，并对异常做出相应的处理。

```python
try:
    ...
except CertainException as e:
    log_something(e)
    do_something(e)

```

**【正例】**
捕获异常，并给出错误信息和提示。

```python
def get_input_password():
    while True:
        password = input('Please enter password: ')
        try:
            check_complexity(password)
        except UserDefined.ComplexityMismatch:
            print('Password must contain 8 or more characters with a mix of letters, numbers & symbols')
            continue
        repeat_password = input('Please repeat password and enter: ')
        try:
            check_consistency(password, repeat_password)
            break
        except UserDefined.ConsistencyMismatch:
            print('Passwords didn’t match. Try again.')

    return password

```

**【例外】**
如果业务场景需要忽略某些异常，并且这些异常不需要做日志记录，此时应增加注释说明忽略的理由。

### 控制语句

#### ❌避免在条件/循环控制语句中包含过多的条件

控制性条件表达式if语句中如果包含过多的条件，会对阅读者造成理解与记忆上的困难，也会在修改时更容易出错。
因此，建议在if语句中的表达式尽量清晰直接，避免陷入具体的条件判断细节。条件判断细节可以在使用if条件判断之前用bool变量代替或封装函数/方法。

if语句中的表达式应清晰直接，并且建议不超过3个，可以根据具体逻辑决定。

**【反例】**

```python
if activity.is_active and activity.remaining > 10 and \
        user.is_active and (user.sex == 'female' or user.level > 3):  # 此处的逻辑非常多，阅读困难，修改容易出错
    user.add_coins(1024)

```

**【正例】**

```python
is_activity_valid = activity.is_active and activity.remaining > 10
is_user_valid = user.is_active and (user.sex == 'female' or user.level > 3)
if is_activity_valid and is_user_valid:  # 此处的逻辑应清晰直接，建议在同一抽象层次上，不要陷入细节
    user.add_coins(1024)
```

#### ✅同一个函数所有分支的返回值类型和个数保持一致

**【级别】** 要求

**【描述】**
同一个函数多个分支返回的对象类型和数量不一致，调用者无法使用统一的类型/逻辑来处理返回值，增加了对不同分支的返回值区分处理的开销以及未来代码修改的风险。
因此，要求同一个函数所有分支的返回值类型和个数保持一致。
`None`可以作为与自定义对象同类型的返回值，但不能作为内置类型的同类。
作为一种特例，如果函数的控制语句没有覆盖所有条件分支，例如所有`if`分支均没有命中时，需要显式指定最终的返回值，而不是使用函数返回值的默认行为（`return None`），即“Explicit is Better than Implicit”。

**【反例】**
下面的函数都包含`if`条件分支，但多分支的返回对象类型不一致。

```python
def function_with_no_else_return_statement(x):
    if x >= 0:
        return x + 1


def function_return_type_inconsistent(x):
    if x < 0:
        return
    return x + 1

```

**【正例】**

```python
INVALID_VALUE = -1


def function_with_return_statement(x):
    if x >= 0:
        return x + 1
    else:
        return INVALID_VALUE  


def function_return_type_consistent(x):
    if x < 0:
        return INVALID_VALUE  
    return x + 1

```

也可以使用类型注解，显式地提示出函数预期的返回对象类型。需要注意的是，类型注解并不真正检查返回值类型和参数类型，只是一种预期。

```python
INVALID_VALUE = -1


def function_with_return_statement(x: int) -> int:
    if x >= 0:
        return x + 1
    else:
        return INVALID_VALUE 


def function_return_type_consistent(x: int) -> int:
    if x < 0:
        return INVALID_VALUE 
    return x + 1

```

**【例外】**
使用`Optional`、`Union`等typing字段声明了函数的返回值类型时，该场景允许函数返回多种指定类型（包含`None`）。

#### ✅使用单个下划线代替循环体中未使用的循环变量

在某些场景下我们在for循环代码块中并不需要使用循环变量。建议使用单个下划线`_`代替未使用的循环变量，尽量减少代码中出现的冗余变量。

此条款同样适用于返回值序列解包场景。

**【正例】**

```python
def function_loop_with_underscore():
    for _ in range(32):
        do_something_several_times()

def function_tuple_unpack_with_underscore():
    a, b, _, d = function_return_a_tuple()
    ...
    return a, b, d
```

### 序列与映射

#### ✅使用dict[key]获取 value 时需要注意保证 key 在有效的范围内

Python的字典dict可以使用`key`获取其对应的`value`。但是当`key`在`dict`的`key`值列表中不存在时，直接使用`dict[key]`获取`value`会报`KeyError`，所以需要注意从代码层面保证`key`在有效的范围内。
可以通过以下方法来处理或避免这类错误：

1. 尽量避免直接使用`dict[key]`的方式从字典中获取`value`，如果一定要使用，需要注意对`key not in dict`的情况做异常处理。
2. 使用`dict.get(key)`方法获取value，并且在使用`dict.get()`方法时应设置默认值并对返回值进行检查，如果不设置默认值的话则默认为`None`。
3. 对于性能要求不高的场景，推荐使用`collections`模块中`defaultdict`类，当取一个字典中不存在的`key`值时，它不会报错或者取到的值为`None`,而是会返回一个设定的默认值。

**【例外】**从代码层面保证使用的key一定在dict存在，那么也可以直接使用[]下标取值。注意如果仅仅是开发者个人判断，建议使用避免KeyError的方式或对KeyError进行处理。

### 表达式

#### ✅推导式和生成器表达式仅用于简单的逻辑表达

列表、字典、集合推导式和生成器表达式均只能在简单的场景下使用：各部分只能占一行（映射表达式、`for`子句、筛选表达式）。避免包含多个`for`子句或筛选表达式。复杂的场景用循环来表达。

**【正例】**
简单的推导式和生成器表达式提供了更紧凑、高效地创建容器类型和迭代器的能力，有助于提升代码的易读性，并且生成器表达式还能避免创建完整的容器。

```Python
result = [{'key': value} for value in range(10000) if is_odd(value)]

result = [
    {'key': key, 'value': value}
    for key, value in generate_iterable(some_input)
    if predicate(key, value)
]

return {
    key: value
    for x in generate_iterable(parameter)
    if predicate(key, value)
}

squares_generator = (x**2 for x in range(10))

unique_names = {user.name for user in users if user}
```



### 代码度量

#### ❌超大函数（huge method） 

**超大函数：** 代码行超过阈值的函数，阈值为50。

**注意：**并不是每一处超大函数的告警，都需要修复，度量是一个全局数据，仅是对代码的整体现状进行评估。

#### ❌超大函数（huge_depth） 

**超大深度函数：**函数深度默认为4，不能超过最大深度。

**注意：**并不是每一处超大深度函数的告警，都需要修复，度量是一个全局数据，仅是对代码的整体现状进行评估；

#### ❌超大圈复杂度（huge cyclomatic complexity）

**超大圈复杂度：**圈复杂度超过阈值的函数，超大圈复杂度的阈值 20。计算控制条件的个数，其中包括了if、else if、else、for、while、case、?表达式、&&、||等的个数，在此基础上再 +1 的结果即为函数的圈复杂度个数。业界其他的工具，可能不会计算else的个数，这是最主要的差异。相比较而言，计算else的个数更为合理，即有无else，其代码复杂度还是稍有差别的。

注意：并不是每一处超大圈复杂度的告警，都需要修复，度量是一个全局数据，仅是对代码的整体现状进行评估；

❌超大CCA圈复杂度（huge cca cyclomatic complexity）

**超大CCA圈复杂度：**CCA圈复杂度超过阈值的函数，超大CCA圈复杂度的阈值 20。对于圈复杂度和CCA圈复杂度，是有区别的：一般的圈复杂度，switch里面有多少case，圈复杂度就加多少，CCA圈复杂度：不管switch里面有多少个case，圈复杂度只加1。

注意：并不是每一处超大CCA圈复杂度的告警，都需要修复，度量是一个全局数据，仅是对代码的整体现状进行评估；

### 日志logging
#### ✅使用日志记录工具实现日志功能

**【描述】**
不要使用标准输出（print）或标准输出（sys.stdout.write），可能会导致难以监控程序运行状况。
建议采用专门的日志记录工具或模块（如：logging）。

- 采用logging模块记录日志；

- 定义独立的日志记录文件；

- 选择正确的日志级别记录日志；

  


## Python语言测试用例规范&约束

1. 如果有新增的类，对于新增的类需要补充用例，保证覆盖率至少达到80%
2. 测试用例命名标准:test_(方法名)\_when_(给定条件)\_then_(期望结果)
3. 坚决不允许无效用例

## 项目级规范&约束
> **说明：** 项目级基本编码规范放于此

