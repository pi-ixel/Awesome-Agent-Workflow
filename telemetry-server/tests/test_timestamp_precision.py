from sqlalchemy import DateTime
from sqlalchemy.dialects import mysql

from aaw_telemetry.database import Base


def test_all_model_datetime_columns_use_mysql_millisecond_precision():
    timestamp_columns = [
        column
        for table in Base.metadata.tables.values()
        for column in table.columns
        if isinstance(column.type, DateTime)
    ]

    assert timestamp_columns
    assert {
        str(column.type.compile(dialect=mysql.dialect())) for column in timestamp_columns
    } == {"DATETIME(3)"}
